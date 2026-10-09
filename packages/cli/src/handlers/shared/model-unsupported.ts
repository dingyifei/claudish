/**
 * Detecting "this provider does not carry that model" from an error response.
 *
 * ## Why this needs its own module
 *
 * Providers do not agree on how to report an unknown model, and some report it
 * under a status reserved for something else entirely. OpenCode Zen Go answers
 * **HTTP 401** with `"Model deepseek-v4-pro-0813 is not supported"` — a status
 * that otherwise means "your credential is bad". Measured 2026-08-18 against a
 * real `OPENCODE_GO_API_KEY`: `zgo@deepseek-v4-pro-0813` returns 401 while
 * `zgo@kimi-k3` on the SAME key returns 200. The credential is provably fine and
 * the status is provably misleading.
 *
 * That matters because Zen Go sits early in a bare-name chain
 * (`deepseek-*` → opencode-zen-go → deepseek → openrouter). The chain still
 * advances — `isRetryableError` treats 401 as retryable, and OpenRouter probes
 * `live` — so no service is lost. What IS lost is the diagnosis: the probe
 * reported `auth-failed`, sending the user to check credentials that are
 * working, and burying the fact that a live hop exists further down.
 *
 * Two places must tell these apart, and they must not drift:
 *
 * 1. `composed-handler.ts` picks the user-facing hint. It already had this test
 *    inline and got it right — "Model not supported by this provider."
 * 2. `probe-live.ts` classifies the probe STATE, and did not — it returned
 *    `auth-failed` on the status alone, before any body inspection.
 *
 * One predicate, so the explanation and the state cannot disagree about what
 * happened. Same reasoning as `quota-exhaustion.ts`, which exists because a
 * spent plan also arrives under an auth-shaped status.
 *
 * Deliberately import-free: `probe-live.ts` has no dependencies at all, and a
 * pure string test keeps it that way with no risk of an import cycle.
 */

/**
 * Phrases that name the MODEL as the problem rather than the credential.
 *
 * Deliberately narrow, and the narrowness is load-bearing in the dangerous
 * direction: a false positive here tells a user with genuinely broken
 * credentials to go and check their model name instead. So every phrase names a
 * model or says "not supported" — never bare "invalid", "denied" or
 * "unauthorized", which are the vocabulary of real auth failures.
 */
const UNSUPPORTED_PHRASES = [
  "not supported",
  "unsupported model",
  "unsupported_model",
  "model not found",
  "model_not_found",
  "unknown model",
  // Alibaba's wording, and it is NOT a typo on our side: the Token Plan and
  // PAYG hosts answer an id their silo does not serve with a bare
  // `400 Model not exist` (measured 2026-09-17; `qwen-alibaba.md` records the
  // dead end it produced). It matched none of the phrases above — not "model
  // not found", not "does not exist" — so the one hint claudish could give was
  // "Request format may be incompatible with provider", which sends the reader
  // to audit a payload that is fine.
  //
  // Recognised for the MESSAGE only. `FallbackHandler.isRetryableError` keeps
  // its own 400 phrase list and deliberately does not carry this one, so the
  // chain still stops on it rather than advancing.
  "model not exist",
  "no such model",
] as const;

/**
 * "not supported" with a PARAMETER as its subject, which is a different fault.
 *
 * The phrase list above is matched anywhere in the body, and "not supported" is
 * the loosest entry in it. Gemini answers a thinking level its model does not
 * take with `400 "Thinking level MINIMAL is not supported for this model."`
 * (measured 2026-09-19 on gemini-3.8-flash). The model is real, reachable and
 * carried; only the one field is wrong. Matching it as model-unsupported told
 * the reader to "Verify model name", which sends them to check a name that is
 * already correct — the same wrong-direction failure the narrowness note above
 * describes, one level down.
 *
 * Keyed on the SUBJECT, not the model: a capability sentence such as "tools are
 * not supported for this model" is also excluded, and rightly so. The model
 * exists there too; what fails is the request's shape.
 */
const PARAMETER_IS_UNSUPPORTED =
  /\b(thinking[ _-]?(level|budget)|reasoning[ _-]?effort|effort|temperature|top[_ ]?[pk]|tool[_ ]?choice|tools?|function[ _-]?calling|parameter|argument|field|image[s]?|audio|video|streaming|stream|json[ _-]?mode|response[ _-]?format|system[ _-]?(prompt|instruction)s?)\b[^.]{0,60}?\b(is|are|was|were)?\s*not supported\b/;

/**
 * True when this error body says the provider does not carry the requested
 * model, whatever status it arrived under.
 *
 * Status-agnostic ON PURPOSE: the whole point is that the status lies. Callers
 * that care about the status combine this with their own check — `probe-live`
 * consults it only for 401/403, because a 404 already means model-not-found and
 * needs no wording test.
 */
export function hasModelUnsupportedWording(errorBody: string): boolean {
  const lower = (errorBody || "").toLowerCase();
  if (PARAMETER_IS_UNSUPPORTED.test(lower)) return false;
  return UNSUPPORTED_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * Whether the provider already told the caller what to DO — i.e. its message
 * carries a link to act on.
 *
 * A generic recovery hint is a guess. When the provider has supplied an
 * actionable instruction, that guess stops being merely unhelpful and starts
 * CONTRADICTING the truth sitting next to it. Measured 2026-08-19, Zen Go
 * answers a model its account has not opted into with:
 *
 *   403 {"error":{"type":"RegionError","message":"The latest version of this
 *        model is only available hosted in China and requires explicit opt in:
 *        https://opencode.ai/workspace/<id>/go"}}
 *
 * The route is fine, the credential is fine, the model IS carried (it is in the
 * dynamic models catalog, so the availability filter correctly kept the provider) — the
 * account simply has not opted into that region. claudish rendered it as
 * "Check API key / OAuth credentials.", sending the user to audit a working key
 * while the fix — a link — sat in the same sentence.
 *
 * Detecting the LINK rather than the wording is deliberate. "RegionError" is one
 * vendor's type name for one policy; the next provider will invent a different
 * one, and a phrase list would have to grow forever to keep up. A URL means the
 * same thing everywhere: there is a specific place to go, and claudish should
 * step out of the way rather than talk over it.
 */
export function hasActionableLink(errorBody: string): boolean {
  return /https?:\/\/\S+/i.test(errorBody || "");
}
