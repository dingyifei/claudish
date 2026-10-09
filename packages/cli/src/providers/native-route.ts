/**
 * The native-passthrough answer that `route()` cannot give, and the proxy's
 * pre-route decision that produces it.
 *
 * A bare name Claude Code owns (`claude-opus-5`, `opus`, `opusplan`,
 * `sonnet[1m]`, `internal`; see `isClaudeCodeModelName`) is served by the
 * proxy's native branch on the harness's own Claude Code auth. `native-anthropic`
 * has no credential store — on purpose, it is not a remote provider — so
 * `route()`'s credential filter drops it and the chain degrades to OpenRouter.
 * The proxy avoids that by asking {@link proxyRouteDecision} BEFORE it ever
 * routes (proxy-server.ts step 2c). Every other caller that consults `route()`
 * for a bare name must ask the same question first, or it reports a
 * subscription model as "no route" / "OpenRouter, metered" — which is what the
 * MCP `preflight` tool and the TUI route probe did.
 *
 * Only Claude Code's names are native, plus `""` and `@model`, which are not
 * model names and which the harness rejects. Any other bare name with no `/`
 * (`o4-mini`, a typo) is `bare`: `parseModelSpec` gives it `AUTO_ROUTE_PROVIDER`,
 * and `route()` decides it like every other bare name. The native passthrough
 * serves none of them, so it used to answer each with an Anthropic 404.
 *
 * Explicit specs are never native: `anthropic@claude-opus-5` names a vendor,
 * and `dv@claude-opus-5-high` is Devin re-serving a Claude id under its own
 * prefix. `parseModelSpec` already resolves that precedence; this only reads it.
 */

import { claudeCodeTierAlias, normalizeNativeModelSpec } from "./claude-code-aliases.js";
import { parseModelSpec } from "./model-parser.js";
import { getProviderByName } from "./provider-definitions.js";

export interface NativeRoute {
  provider: "native-anthropic";
  /** The tier id that will actually be sent — `opus` and `internal` are normalized. */
  modelSpec: string;
  displayName: string;
  /**
   * True when `model` is a Claude Code tier alias (`opus`, `internal`, …). Those
   * are selectors, not API model ids: the native handler forwards the request's
   * model verbatim and Anthropic rejects an alias, so a probe must SKIP them and
   * send only concrete names. Everything else — including a `claude-` typo,
   * which the proxy really does send natively — must be probed, never declared
   * live.
   */
  isTierAlias: boolean;
}

/**
 * What the proxy does with a target before `route()` could see it.
 *
 * Only `bare` reaches `route()`. The other three are served without a routing
 * chain, by the proxy steps that follow its gate.
 */
export type ProxyRouteDecision =
  /** Served on Claude Code's own auth by the native passthrough. */
  | { type: "native"; route: NativeRoute }
  /**
   * No routing chain. `spec` is the target verbatim, the string the proxy carries
   * past its gate. `via: "vendor-qualified-id"` is `anthropic/<id>`: it matches
   * native-anthropic's `/^anthropic\//i` pattern, yet the proxy never serves it
   * natively (its native branch refuses any `/`), so it reaches the OpenRouter
   * handler with the id unchanged.
   */
  | {
      type: "explicit";
      provider: string;
      model: string;
      spec: string;
      via: "model-spec" | "vendor-qualified-id";
    }
  /** `poe:<id>`, served by the Poe handler. `model` is the id without the prefix. */
  | { type: "poe"; model: string }
  /** `route()` decides. `model` is the parsed name: a known `vendor/` is stripped. */
  | { type: "bare"; model: string };

/**
 * What every surface says about a native link instead of a probe result: `--probe`,
 * the MCP preflight and the config TUI's route probe.
 *
 * A native link is never probed. The native handler authenticates by forwarding
 * the INBOUND request's Claude Code header, and a synthetic request from this
 * process carries none, so its answer is noise: "x-api-key header is required"
 * for a healthy model and a typo alike. Substituting `ANTHROPIC_API_KEY` probes a
 * different credential from the one a session uses. So it is a third outcome,
 * neither live nor failed.
 */
export const NATIVE_NOT_PROBED =
  "not probed — served on Claude Code's own auth, which this process cannot forward";

/** The prefix the proxy's `isPoeModel` tests, case-sensitively, as it always has. */
const POE_PREFIX = "poe:";

/**
 * The proxy's gate (proxy-server.ts step 2c) as one function. The proxy, the
 * native test below, prehydrate's pin and `--probe` all read this, so none of
 * them can disagree with the proxy about which names reach `route()`.
 *
 * The checks run in the order the proxy applies them: an explicit spec (which
 * covers `provider@model`, a URL and a legacy prefix), then `poe:`, then a name
 * the parser attributes to native-anthropic, then everything else.
 */
export function proxyRouteDecision(target: string): ProxyRouteDecision {
  const parsed = parseModelSpec(target);
  if (parsed.isExplicitProvider) {
    return {
      type: "explicit",
      provider: parsed.provider,
      model: parsed.model,
      spec: target,
      via: "model-spec",
    };
  }
  if (target.startsWith(POE_PREFIX)) {
    return { type: "poe", model: target.slice(POE_PREFIX.length) };
  }
  if (parsed.provider === "native-anthropic") {
    // A slash-qualified id (`anthropic/claude-opus-5`) matches native-anthropic's
    // `/^anthropic\//i` pattern in parseModelSpec, but the proxy does not serve it
    // natively — its native branch is `!target.includes("/") && !hasExplicitProvider`,
    // so it goes to OpenRouter, metered. Calling it native would be the same lie
    // the native test exists to remove, in the other direction.
    if (target.includes("/")) {
      return {
        type: "explicit",
        provider: "openrouter",
        model: target,
        spec: target,
        via: "vendor-qualified-id",
      };
    }
    return { type: "native", route: nativeRouteOf(target) };
  }
  return { type: "bare", model: parsed.model };
}

function nativeRouteOf(model: string): NativeRoute {
  return {
    provider: "native-anthropic",
    modelSpec: normalizeNativeModelSpec(model),
    displayName: getProviderByName("native-anthropic")?.displayName ?? "Anthropic (Native)",
    isTierAlias: claudeCodeTierAlias(model) !== null,
  };
}

/**
 * Non-null only for a BARE name (no `@`, no `/`) that `parseModelSpec` attributes
 * to native-anthropic — the proxy's `native` decision.
 */
export function nativeRouteFor(model: string): NativeRoute | null {
  const decision = proxyRouteDecision(model);
  return decision.type === "native" ? decision.route : null;
}
