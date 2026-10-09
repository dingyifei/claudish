/**
 * Which xAI models accept `reasoning_effort` — decided at RUNTIME, not from a
 * pinned model list.
 *
 * ## Why this module exists
 *
 * The previous design was an ALLOWLIST: send `reasoning_effort` only to models
 * enumerated as accepting it, strip for everything else. Its stated rationale was
 * sound — naming genuinely cannot gate this, because `grok-4.20-0309-reasoning`
 * IS a reasoning model with a dot-decimal `grok-4.x` shape and still rejects the
 * parameter, while `grok-4.3` accepts it. So the list enumerated accepting
 * families and made unknown models fail "safe".
 *
 * That default is what broke `grok-4.6`. An allowlist decides the UNKNOWN case,
 * and every model xAI ships after the list was written is unknown. The two
 * failure modes are wildly asymmetric:
 *
 *   · Sending the param to a model that rejects it → HTTP 400, one wasted
 *     round-trip, immediately visible, and (now) automatically recovered.
 *   · Stripping it from a model that accepts it → the user's effort setting is
 *     SILENTLY discarded and the model runs at the provider's default tier.
 *     Nothing logs, nothing fails, and the only symptom is that everything is
 *     slow.
 *
 * Measured 2026-08-15 against api.x.ai, `grok-4.6`, mean of 3 runs on a prompt
 * that invites deliberation:
 *
 *   effort omitted (what claudish sent)   1387 reasoning tokens   23.7s
 *   reasoning_effort: low                  722 reasoning tokens   13.0s
 *   reasoning_effort: high                1657 reasoning tokens   26.4s
 *
 * So the default sits near `high`, and `low` is 1.8x faster. A real `team` run
 * (session team-20260815-115227) had grok-4.6 spend 170-185s per turn thinking
 * across 10 turns and blow a 900s deadline, while five other models finished in
 * 2-10 minutes. The user had no way to turn it down: `grok-4.6` matched no
 * allowlist entry, so the effort never reached the wire.
 *
 * ## The rule — three tiers, most authoritative first
 *
 *   1. **What the live API told us.** A 400 recorded this session is the last
 *      word; nothing overrides direct evidence.
 *   2. **The hosted model catalog** (`lookupModelReasoning`). This is the tier
 *      that keeps FUTURE models working without a claudish release: the catalog
 *      is served by models-index and already carries, per model, whether
 *      reasoning is `supported` and whether its `control` is `"effort"` (takes
 *      the parameter) or `"toggle"` (on/off only — the parameter 400s). Verified
 *      2026-08-15 to reproduce every live measurement above independently,
 *      including that grok-4.3 advertises `none` while grok-4.5/4.6 do not.
 *      `OpenAIAPIFormat.supportsReasoningEffort` established this "CATALOG
 *      FIRST" pattern for exactly the same reason; Grok simply never adopted it.
 *   3. **Name rules** — cold-cache fallback ONLY, and optimistic: an id the
 *      catalog has no opinion on gets the parameter unless `SEED_REJECTS`
 *      recognises it.
 *
 * `SEED_REJECTS` is a fast path that spares a known-bad model one 400 while the
 * catalog is cold; it is NOT authoritative and never decides a case the catalog
 * can. This inverts which case needs maintenance: an unknown model now costs at
 * most one recovered 400, instead of silently losing a capability forever.
 */

import { log } from "../logger.js";
import { lookupModelReasoning } from "./model-catalog.js";

/**
 * Live-measured 2026-08-15 against `api.x.ai/v1/chat/completions` — every id that
 * returned `400 Model <id> does not support parameter reasoningEffort`.
 *
 * Purely an optimisation. Deleting this set changes no verdict; it only costs
 * each listed model one recovered 400 on first use. Do NOT add a model here to
 * express a guess — an absent model is meant to be discovered, not assumed.
 */
const SEED_REJECTS: readonly RegExp[] = [
  // Explicitly non-reasoning variants, whatever the family.
  /non-reasoning/i,
  /^grok-2/i,
  // Integer grok-4 line (grok-4, grok-4-0709). The negative lookaheads are
  // load-bearing: `grok-4.3` / `grok-4.5` / `grok-4.6` ACCEPT the parameter, and
  // the `grok-*-fast-reasoning` family historically accepts it too — neither may
  // be caught by a pattern aimed at bare `grok-4`.
  /^grok-4(?![.\d])(?!.*fast-reasoning)/i,
  /^grok-build-/i,
  /^grok-code-/i,
  // The whole grok-4.20 line rejects, despite being dot-decimal AND reasoning —
  // this is the case that proves naming alone cannot gate the parameter.
  /^grok-4\.20/i,
];

/** Models the API has told us, at runtime, do not accept the parameter. */
const learnedRejects = new Set<string>();

const norm = (modelId: string): string =>
  modelId
    .trim()
    .toLowerCase()
    .replace(/^x-ai\//, "");

/**
 * Should this request carry `reasoning_effort`?
 *
 * Three tiers (see the module header): live evidence → hosted catalog → name
 * rules. `false` always rests on positive evidence — a recorded 400, or a
 * catalog entry saying this model has no effort knob — never on mere absence of
 * evidence, which is what the old allowlist got wrong.
 */
export function acceptsReasoningEffort(modelId: string): boolean {
  const id = norm(modelId);
  if (!id) return false;

  // 1. The live API's own verdict outranks everything.
  if (learnedRejects.has(id)) return false;

  // 2. The catalog. `control: "toggle"` means reasoning exists but has no depth
  //    knob — sending the parameter 400s (measured: grok-4.20-0309-reasoning,
  //    grok-build-0.1, grok-code-fast-1 are all `toggle`).
  const reasoning = lookupModelReasoning(id) ?? lookupModelReasoning(modelId);
  if (reasoning) return reasoning.supported === true && reasoning.control === "effort";

  // 3. Cold cache or a model newer than the catalog → optimistic name rules.
  return !SEED_REJECTS.some((re) => re.test(id));
}

/**
 * The effort ladder this model advertises, when the catalog knows it.
 *
 * Returned so the dialect can clamp instead of guessing. This is what removes
 * the need to learn `none` support by 400: the catalog already states that
 * grok-4.3 advertises `none` and grok-4.5/4.6 do not.
 */
export function catalogReasoningFor(modelId: string) {
  return lookupModelReasoning(norm(modelId)) ?? lookupModelReasoning(modelId);
}

/**
 * Record that the API rejected `reasoning_effort` for this model, so we stop
 * sending it. Process-lifetime memory: the proxy outlives the session, and a
 * restart costs one more recovered 400 rather than breaking anything.
 */
export function rememberReasoningEffortRejected(modelId: string): void {
  const id = norm(modelId);
  if (!id || learnedRejects.has(id)) return;
  learnedRejects.add(id);
  log(`[GrokEffortSupport] ${id} rejected reasoning_effort — not sending it again this session.`);
}

/**
 * Does this upstream error body specifically say the model does not take
 * `reasoning_effort` AT ALL?
 *
 * Deliberately narrow. `grok-4.20-multi-agent-0309` also 400s, but with
 * "Multi Agent requests are not allowed on chat completions" — retrying that one
 * without the parameter fails identically, so it must NOT match. Only a
 * rejection naming the parameter is recoverable by dropping the parameter.
 *
 * Observed shape (2026-08-15):
 *   {"code":"invalid-argument",
 *    "error":"Model grok-build-0.1 does not support parameter reasoningEffort."}
 */
export function isReasoningEffortRejection(errorText: string): boolean {
  if (!errorText) return false;
  // The wire spelling is camelCase `reasoningEffort`; accept snake_case too in
  // case the provider ever echoes the field name as sent.
  return /does not support parameter\s+`?reasoning[_]?effort`?/i.test(errorText);
}

// ─── Value-level support ─────────────────────────────────────────────────────
//
// A model can accept the PARAMETER and still reject a particular VALUE. Measured
// 2026-08-15: `grok-4.3` accepts `none`, while `grok-4.5` and `grok-4.6` answer
//
//   {"code":"invalid-argument",
//    "error":"This model does not support `reasoning_effort` value `none`."}
//
// That is a second axis, and enumerating it per model would recreate exactly the
// stale-model-list problem this module exists to remove. So it is learned the same
// way: send the honest mapping, and on a value rejection remember the specific
// (model, value) pair and fall back one rung.

/** `${model} ${value}` pairs the API has rejected. */
const learnedValueRejects = new Set<string>();

const pairKey = (modelId: string, value: string) => `${norm(modelId)} ${value.toLowerCase()}`;

/** Is this specific effort value known-bad for this model? */
export function acceptsReasoningEffortValue(modelId: string, value: string): boolean {
  return !learnedValueRejects.has(pairKey(modelId, value));
}

/** Record that the API rejected this specific value for this model. */
export function rememberReasoningEffortValueRejected(modelId: string, value: string): void {
  const key = pairKey(modelId, value);
  if (learnedValueRejects.has(key)) return;
  learnedValueRejects.add(key);
  log(
    `[GrokEffortSupport] ${norm(modelId)} rejected reasoning_effort value "${value}" — ` +
      "falling back and not sending it again this session."
  );
}

/**
 * Extract the rejected value from a value-level rejection, or null when the body
 * is not one. Distinct from `isReasoningEffortRejection`: that one means "drop
 * the parameter", this one means "keep the parameter, pick another value".
 */
export function rejectedReasoningEffortValue(errorText: string): string | null {
  if (!errorText) return null;
  const m = /does not support\s+`?reasoning[_]?effort`?\s+value\s+`?([a-z]+)`?/i.exec(errorText);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The next value to try after `value` was rejected, or null when there is
 * nothing weaker left and the parameter should simply be dropped.
 *
 * Only ever steps toward LESS reasoning: a rejected value means the model cannot
 * do that tier, and silently escalating a user's "none" into "high" would invert
 * their intent and cost them money.
 */
export function fallbackReasoningEffortValue(value: string): string | null {
  switch (value.toLowerCase()) {
    case "none":
      return "low";
    case "minimal":
      return "low";
    case "low":
      return null;
    case "medium":
      return "low";
    case "high":
      return "medium";
    default:
      return null;
  }
}

/** Test seam. */
export function resetReasoningEffortMemo(): void {
  learnedRejects.clear();
  learnedValueRejects.clear();
}

/** Test seam. */
export function learnedReasoningEffortRejects(): string[] {
  return [...learnedRejects];
}
