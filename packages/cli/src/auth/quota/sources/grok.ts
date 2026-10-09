/**
 * Grok Build (SuperGrok / X Premium+) quota adapter.
 *
 * The second provider claudish supports with a real usage API, and the richer
 * of the two: `GET /v1/billing?format=credits` on the same host the CLI already
 * talks to returns a usage percentage, the billing window's start AND end, and
 * a per-product breakdown.
 *
 * Like Antigravity's and unlike Codex's, this endpoint is FREE — a metadata GET
 * that runs no inference — which is what makes `poll` legitimate under the rule
 * "never spend quota to measure quota". Codex has to fire a real inference
 * request to read its headers, so it gets no `poll`; here the same call serves
 * both the timer and the explicit command.
 *
 * The endpoint was found by `strings` on the shipped Grok binary (it carries a
 * `xai-grok-shell/src/extensions/billing.rs` module whose error prose names the
 * path), then confirmed live. It is genuinely authenticated: a deliberately
 * bogus token answers 401, so a 200 here is evidence about the credential and
 * not a public list — the trap Alibaba's `coding-intl` list set.
 *
 * Full protocol write-up: `ai-docs/reports/grok-subscription/protocol-spec.md`.
 */

import { log } from "../../../logger.js";
import {
  grokAuthHeaders,
  hasGrokCredentials,
  readGrokProxyUrl,
  resolveGrokAccessToken,
  resolveGrokClientVersion,
} from "../../../providers/grok/grok-credentials.js";
import type { QuotaAdapter, QuotaPollContext } from "../adapter.js";
import { type PlanUsage, type QuotaCapability, type QuotaWindow, toUsedPct } from "../types.js";

/** The billing surface. `format=credits` is the shape the Grok CLI requests. */
const BILLING_PATH = "/billing?format=credits";

/** Only the fields this adapter reads. */
interface GrokBillingConfig {
  creditUsagePercent?: number;
  currentPeriod?: { type?: string; start?: string; end?: string };
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  productUsage?: Array<{ product?: string; usagePercent?: number }>;
}

/**
 * Turn the backend's period enum into the short label the status line renders
 * verbatim in a one-line budget.
 *
 * Derived from the enum rather than from the start/end delta: a weekly window
 * measured across a daylight-saving boundary is not exactly 7×24h, and
 * computing "6d23h" from arithmetic would be precise about the wrong thing.
 * An unrecognised enum falls back to the raw suffix, so a new period type
 * degrades to an odd-looking label rather than to no window at all.
 */
export function periodLabel(type: string | undefined): string {
  switch (type) {
    case "USAGE_PERIOD_TYPE_WEEKLY":
      return "7d";
    case "USAGE_PERIOD_TYPE_DAILY":
      return "24h";
    case "USAGE_PERIOD_TYPE_MONTHLY":
      return "30d";
    default:
      if (!type) return "period";
      return type.replace(/^USAGE_PERIOD_TYPE_/, "").toLowerCase() || "period";
  }
}

/**
 * Build windows from a billing config. Exported for tests — pure, no I/O.
 *
 * Prefers the PER-PRODUCT breakdown over the account-level
 * `creditUsagePercent`, because they are not interchangeable: a Grok
 * subscription meters GrokBuild, GrokChat and GrokImagine separately, and the
 * one claudish spends is GrokBuild. Reporting the account roll-up would answer
 * a question the user did not ask, and would read as low while the surface they
 * actually use approached its limit.
 *
 * Products that report NO percentage are omitted rather than shown as 0%: the
 * field is absent for products this plan does not meter, and a permanent "0%"
 * bar for a limit that does not exist is the same phantom-window bug the Codex
 * adapter documents.
 */
export function windowsFromBilling(config: GrokBillingConfig): QuotaWindow[] {
  const resetsAt = config.currentPeriod?.end ?? config.billingPeriodEnd;
  const label = periodLabel(config.currentPeriod?.type);

  const windows: QuotaWindow[] = [];
  for (const entry of config.productUsage ?? []) {
    if (typeof entry?.usagePercent !== "number" || !entry.product) continue;
    const used = toUsedPct(entry.usagePercent);
    if (used === undefined) continue;
    const w: QuotaWindow = { id: entry.product, used_pct: used };
    if (resetsAt) w.resets_at = resetsAt;
    windows.push(w);
  }

  // Fall back to the account-level figure only when no product reported one,
  // so a plan shape we have not seen still produces a reading instead of
  // silently looking like "no usage surface".
  if (windows.length === 0 && typeof config.creditUsagePercent === "number") {
    const used = toUsedPct(config.creditUsagePercent);
    if (used !== undefined) {
      const w: QuotaWindow = { id: label, used_pct: used };
      if (resetsAt) w.resets_at = resetsAt;
      windows.push(w);
    }
  }
  return windows;
}

/** One request, shared by `poll` and `fetchExplicit` — both read the free endpoint. */
async function fetchPlan(): Promise<PlanUsage | undefined> {
  try {
    const [token, version] = await Promise.all([
      resolveGrokAccessToken(),
      resolveGrokClientVersion(),
    ]);
    const res = await fetch(`${readGrokProxyUrl()}${BILLING_PATH}`, {
      method: "GET",
      // The client-identity headers are mandatory on this host: without them
      // the proxy answers 426 for an "outdated CLI" rather than serving.
      headers: grokAuthHeaders(token, version),
    });
    if (!res.ok) {
      log(`[quota:grok] billing fetch failed: ${res.status}`);
      return undefined;
    }

    const body = (await res.json()) as { config?: GrokBillingConfig };
    const config = body?.config;
    if (!config) return undefined;

    const windows = windowsFromBilling(config);
    if (windows.length === 0) return undefined;

    return {
      label: "Grok Build",
      windows,
      source: "provider",
      observed_at: new Date().toISOString(),
    };
  } catch (err) {
    log(`[quota:grok] billing fetch error: ${err}`);
    return undefined;
  }
}

export const grokQuotaAdapter: QuotaAdapter = {
  providerId: "grok-subscription",
  label: "Grok Build",

  capability(): QuotaCapability {
    return { kind: "endpoint" };
  },

  isAvailable(): boolean {
    // Sync on purpose — the CLI's provider list and the registry lookup cannot
    // await. Covers BOTH credential sources: `claudish login grok` and an
    // existing `grok login`.
    try {
      return hasGrokCredentials();
    } catch {
      return false;
    }
  },

  poll(_ctx?: QuotaPollContext): Promise<PlanUsage | undefined> {
    return fetchPlan();
  },

  fetchExplicit(_ctx?: QuotaPollContext): Promise<PlanUsage | undefined> {
    return fetchPlan();
  },
};
