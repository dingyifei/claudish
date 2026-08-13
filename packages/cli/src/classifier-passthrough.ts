// Classifier passthrough — resolve the opt-in that reroutes Claude Code's
// auto-mode permission classifier to native Anthropic while the main loop runs
// on another provider, and prepare the detected request for that hop.
//
// Detection itself lives in behavior/harness.ts, with every other Claude Code
// prompt anchor we match on. This module owns configuration and the payload
// rewrite, and stays dependency-light (a type import plus the synchronous
// catalog reader) so it can be unit-tested in isolation and imported from the
// auth gate without dragging in cli.ts / proxy-server.ts.

import { findEntryByAlias } from "./providers/catalog-query.js";
import type { ClaudishConfig } from "./types.js";

/**
 * Curated "current Anthropic sonnet tier" pointer in the hosted slim catalog.
 * The `~<provider>/<family>-latest` alias family is maintained in models-index.
 * Pinned here as ONE string so a catalog convention change is a one-line edit —
 * the model id itself is never pinned.
 */
const SONNET_LATEST_ALIAS = "~anthropic/claude-sonnet-latest";

/**
 * LAST RESORT only, and the only concrete model id in this file. Reached when
 * no flag, env, or sonnet role mapping applies AND the catalog is cold — which
 * is legitimate: `--models-skip-update` and local (`ollama@` / `lmstudio@`)
 * models skip the launcher's catalog warm entirely (see catalog-warm.ts
 * `shouldWarmCatalog`).
 */
const FALLBACK_CLASSIFIER_MODEL = "claude-sonnet-5";

export interface ClassifierConfig {
  /** Whether classifier passthrough is active for this session. */
  enabled: boolean;
  /** Native Claude model id the classifier request is rewritten onto. */
  model: string;
}

type ClassifierConfigInput = Pick<
  ClaudishConfig,
  "classifierModel" | "classifierProvider" | "classifierPassthrough" | "modelSonnet"
>;

/**
 * Is this a model id the Anthropic API will actually accept?
 *
 * A NAMING RULE, not a roster — the repo's convention for native-Claude checks.
 * Deliberately rejects Claude Code's internal tier aliases (`internal`, `sonnet`)
 * which parseModelSpec() also classifies as "native-anthropic" but which
 * api.anthropic.com rejects, and anything carrying a provider prefix or vendor
 * path (`cx@gpt-5.6-sol`, `anthropic/claude-sonnet-5`).
 */
export function isNativeClaudeModelId(spec: string | undefined): spec is string {
  if (!spec) return false;
  const s = spec.trim();
  return /^claude-/i.test(s) && !s.includes("@") && !s.includes("/");
}

/**
 * Narrower still: is this a SONNET-tier Claude id? Used to decide whether the
 * session's own `--model-sonnet` mapping can serve as the classifier model.
 * `/^claude-/` alone is too loose — a user may map the sonnet role to Opus or
 * Haiku, and running the classifier on Opus is needlessly slow and expensive.
 */
function isSonnetFamilyId(spec: string | undefined): spec is string {
  return isNativeClaudeModelId(spec) && /^claude-sonnet-/i.test(spec.trim());
}

/**
 * Resolve the model the classifier is rewritten onto, in priority order:
 *
 *   1. `--classifier-model <m>`
 *   2. `CLAUDISH_CLASSIFIER_MODEL`
 *   3. the session's own `--model-sonnet` mapping, if it is a real sonnet id —
 *      the docs already tell users to map that role to preserve their OAuth, so
 *      an explicit mapping is honoured before any lookup
 *   4. the catalog's current sonnet-tier pointer
 *   5. FALLBACK_CLASSIFIER_MODEL
 *
 * EVERY tier is synchronous, and that is load-bearing: this feeds
 * `classifierPassthroughEnabled()` → `shouldPreserveNativeAuth()` →
 * `isProxyAuthMode()`, which is exported sync and asserted sync in tests. An
 * async catalog lookup here would cascade `await` through the auth gate.
 */
export interface ClassifierModelDeps {
  /**
   * Catalog alias lookup. Injectable so tests can exercise the catalog tier
   * without a process-wide module mock — `mock.module` would leave this file's
   * import patched for every suite that runs after it in the same process.
   */
  lookupAlias?: (alias: string) => { modelId: string } | null;
}

export function resolveClassifierModel(
  config: ClassifierConfigInput,
  env: NodeJS.ProcessEnv = process.env,
  deps: ClassifierModelDeps = {}
): string {
  const flagModel = config.classifierModel?.trim();
  if (flagModel) return flagModel;

  const envModel = env.CLAUDISH_CLASSIFIER_MODEL?.trim();
  if (envModel) return envModel;

  const sonnetRole = config.modelSonnet?.trim();
  if (isSonnetFamilyId(sonnetRole)) return sonnetRole.trim();

  // A syntactically valid but structurally malformed catalog cache would throw
  // inside the lookup (entries are cast, not validated). A corrupt cache must
  // never block launch, so fall through to the literal.
  try {
    const lookupAlias = deps.lookupAlias ?? findEntryByAlias;
    const latest = lookupAlias(SONNET_LATEST_ALIAS)?.modelId;
    if (latest) return latest;
  } catch {
    // fall through
  }

  return FALLBACK_CLASSIFIER_MODEL;
}

/**
 * Is the passthrough switched on? Pure: reads config and env only, never the
 * filesystem, so the auth gate can call it freely.
 *
 * Enabled (default OFF) by any of `--classifier-model`, `--classifier-provider
 * anthropic`, `CLAUDISH_CLASSIFIER_PROVIDER=anthropic`, or
 * `CLAUDISH_CLASSIFIER_MODEL`. `--no-classifier-passthrough` and a falsey
 * `CLAUDISH_CLASSIFIER_PROVIDER` (`off` / `0` / `false`) force it off and win
 * over every enabling source — without them a stray env var in a shell profile
 * would turn the passthrough on for every session with no way to turn it back off.
 */
function classifierEnabled(
  config: ClassifierConfigInput,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (config.classifierPassthrough === false) return false;

  const envProviderRaw = env.CLAUDISH_CLASSIFIER_PROVIDER?.trim().toLowerCase();
  if (envProviderRaw === "off" || envProviderRaw === "0" || envProviderRaw === "false") {
    return false;
  }

  return (
    !!config.classifierModel?.trim() ||
    config.classifierProvider?.trim().toLowerCase() === "anthropic" ||
    envProviderRaw === "anthropic" ||
    !!env.CLAUDISH_CLASSIFIER_MODEL?.trim()
  );
}

/** Resolve the full classifier-passthrough configuration for this session. */
export function resolveClassifierConfig(
  config: ClassifierConfigInput,
  env: NodeJS.ProcessEnv = process.env,
  deps: ClassifierModelDeps = {}
): ClassifierConfig {
  return {
    enabled: classifierEnabled(config, env),
    model: resolveClassifierModel(config, env, deps),
  };
}

/** Convenience wrapper: whether classifier passthrough is enabled this session. */
export function classifierPassthroughEnabled(
  config: ClassifierConfigInput,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return classifierEnabled(config, env);
}

/**
 * Prepare a detected classifier request for the native Anthropic hop: force it
 * onto `model` and normalise the fields a rewritten model would reject.
 * Mutates `body` in place.
 *
 * `thinking` is PRESERVED, not deleted. Deleting it looks harmless and is not:
 * omitting `thinking` makes Claude 5 models run ADAPTIVE thinking, and the
 * captured classifier request pairs `thinking: {type:"disabled"}` with
 * `max_tokens: 64` — so a deleted field turns a deliberately non-thinking,
 * latency-sensitive call into a reasoning one whose thinking eats the entire
 * token budget, truncating the verdict it exists to produce. The only shape
 * that must be rewritten is the pre-4.6 `{type:"enabled", budget_tokens:N}`
 * form, which is a hard 400 on every 5-family model.
 *
 * Sampling parameters are dropped: non-default `temperature`/`top_p`/`top_k`
 * are rejected outright by the 5-family models this rewrites onto. Claude Code
 * does not currently send them on the classifier request, so this is a guard
 * against drift rather than a live fix.
 */
export function rewriteClassifierForNative(body: Record<string, unknown>, model: string): void {
  body.model = model;

  const thinking = body.thinking as { type?: unknown } | undefined;
  if (thinking && typeof thinking === "object" && thinking.type === "enabled") {
    body.thinking = { type: "disabled" };
  }

  delete body.temperature;
  delete body.top_p;
  delete body.top_k;
}
