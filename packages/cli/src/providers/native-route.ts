/**
 * The native-passthrough answer that `route()` cannot give.
 *
 * A bare Claude name (`claude-opus-5`, `opus`, `internal`) is served by the
 * proxy's native branch on the harness's own Claude Code auth. `native-anthropic`
 * has no credential store — on purpose, it is not a remote provider — so
 * `route()`'s credential filter drops it and the chain degrades to OpenRouter.
 * The proxy avoids that by checking `parsed.provider !== "native-anthropic"`
 * BEFORE it ever routes (proxy-server.ts). Every other caller that consults
 * `route()` for a bare name must make the same check first, or it reports a
 * subscription model as "no route" / "OpenRouter, metered" — which is what the
 * MCP `preflight` tool and the TUI route probe did.
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
   * send only concrete names. Everything else — including a typo, which the
   * proxy really does route natively — must be probed, never declared live.
   */
  isTierAlias: boolean;
}

/**
 * Non-null only for a BARE name (no `@`, no `/`) that `parseModelSpec` attributes
 * to native-anthropic — the same condition the proxy's native branch applies.
 */
export function nativeRouteFor(model: string): NativeRoute | null {
  // Mirror proxy-server.ts's native branch EXACTLY:
  //   const isNative = !target.includes("/") && !hasExplicitProvider;
  // A slash-qualified id (`anthropic/claude-opus-5`) matches native-anthropic's
  // `/^anthropic\//i` pattern in parseModelSpec, but the proxy does not serve it
  // natively — it goes to OpenRouter, metered. Reporting it native here would be
  // the same lie this helper exists to remove, in the other direction.
  if (model.includes("/")) return null;
  const parsed = parseModelSpec(model);
  if (parsed.isExplicitProvider || parsed.provider !== "native-anthropic") return null;
  return {
    provider: "native-anthropic",
    modelSpec: normalizeNativeModelSpec(model),
    displayName: getProviderByName("native-anthropic")?.displayName ?? "Anthropic (Native)",
    isTierAlias: claudeCodeTierAlias(model) !== null,
  };
}
