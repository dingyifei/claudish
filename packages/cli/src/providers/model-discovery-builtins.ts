/**
 * The three builtin roster fetchers that are not an HTTP GET.
 *
 * They live HERE, behind `registerModelDiscoveryFetcher`, rather than as
 * `if (descriptor.format === …)` branches inside `model-discovery.ts`. The
 * devin branch predicted this file: "If a third such provider ever appears,
 * replace this branch with a `registerModelDiscoveryFetcher(name, fn)` seam —
 * not worth it for one." Antigravity was the third.
 *
 * What the move buys is dependency DIRECTION. Previously the generic discovery
 * module had to know about Devin's protobuf rpcs, Antigravity's OAuth POST and
 * Ollama's daemon shape, so adding provider #4 meant editing a file that has
 * nothing to do with provider #4. Now it knows none of them: it loads this
 * bundle once, on the first format it cannot serve itself.
 *
 * This module is only ever imported dynamically, which is what keeps the
 * protobuf codec and the Antigravity OAuth path off the cold-start path — the
 * property the original dynamic `import()` calls existed to protect.
 */

import type { DiscoveredModel } from "./model-discovery.js";
import { registerModelDiscoveryFetcher } from "./model-discovery.js";

/**
 * Devin's roster is capability ∩ entitlement over two protobuf rpcs.
 *
 * Carries the full variant metadata, not just id/name/window: the picker folds
 * ~170 uids into ~42 rows and needs the group label, the cost multiplier, the
 * promo and the vendor's own default flag to do it.
 */
async function fetchDevinRoster(): Promise<DiscoveredModel[]> {
  const { getServedDevinModels } = await import("./devin/devin-models.js");
  const served = await getServedDevinModels();
  if (served.length === 0) return [];

  const { devinRosterEntry } = await import("./model-resolvers/devin.js");
  return served.map((model) => {
    const { wireId, ...rest } = devinRosterEntry(model);
    return { id: wireId, ...rest };
  });
}

/**
 * Ids the backend does not declare, but which are still not chat models.
 *
 * `fetchAvailableModels` states unselectability three ways — `isInternal`, the
 * per-feature role lists, and `deprecatedModelIds` — and those cover everything
 * except the `tab_*` pair, which appears in no list and carries no flag. They
 * are the editor's as-you-type completion models: 4096 max output, no thinking,
 * no images, `recommended: false`. They answer HTTP 200, which is precisely what
 * made a wrong-host problem look like a rate limit for an entire session.
 *
 * Prefix-matched, because the ids carry build numbers that rot on each roster
 * roll. This is the ONLY guess left in the filter; everything else is declared.
 */
function isUndeclaredEditorInternal(id: string): boolean {
  return id.startsWith("tab_");
}

/**
 * Antigravity lists over an OAuth POST to a Google internal endpoint, not a GET.
 *
 * The reason it is worth a fetcher at all is `maxTokens`: the response reports
 * the window THIS subscription is served, and it disagrees with the shared
 * catalog — `claude-sonnet-4-6` is 250,000 from the backend against 1,000,000
 * in the catalog. `resolveDiscoveredContextLength` already prefers a discovered
 * window over the catalog; this is what gives it one to prefer.
 */
async function fetchAntigravityRoster(): Promise<DiscoveredModel[]> {
  const { getValidAntigravityAccessToken } = await import("../auth/antigravity-token.js");
  const { setupAntigravityUser, getServedAntigravityModels } = await import(
    "../auth/antigravity-user.js"
  );
  const token = await getValidAntigravityAccessToken();
  if (!token) return [];

  const { projectId } = await setupAntigravityUser(token);
  const { servedIds, meta, excludedIds } = await getServedAntigravityModels(token, projectId);
  // Declared first, guess second. `excludedIds` is the backend's own verdict —
  // internal flags, per-feature role bindings, and retired ids (which look
  // entirely normal but answer 400).
  const declaredExcluded = excludedIds ?? new Set<string>();
  const selectable = servedIds.filter(
    (id) => !declaredExcluded.has(id) && !isUndeclaredEditorInternal(id)
  );
  return selectable.map((id) => {
    const m = meta[id];
    // contextWindow is left UNSET when the backend reported none
    // (gemini-3.1-flash-image does), so the catalog still gets its turn rather
    // than the row rendering a fabricated 0 as "N/A".
    // Every id here is a tuned variant (`-high`, `-tiered`) the catalog does not
    // carry; see `ignoreCatalogReleaseDate` for the ordering this protects.
    return m?.contextWindow
      ? { id, contextWindow: m.contextWindow, ignoreCatalogReleaseDate: true }
      : { id, ignoreCatalogReleaseDate: true };
  });
}

/** Ollama's daemon speaks its own listing shape and carries capability data no OpenAI list has. */
async function fetchOllamaRoster(): Promise<DiscoveredModel[]> {
  const { fetchOllamaModels } = await import("./ollama-discovery.js");
  const installed = await fetchOllamaModels({ enrichCapabilities: false });
  return installed.map((model) => ({
    id: model.name,
    displayName: model.name,
    supportsTools: model.supportsTools,
  }));
}

registerModelDiscoveryFetcher("devin-connect", fetchDevinRoster);
registerModelDiscoveryFetcher("antigravity", fetchAntigravityRoster);
registerModelDiscoveryFetcher("ollama-tags", fetchOllamaRoster);
