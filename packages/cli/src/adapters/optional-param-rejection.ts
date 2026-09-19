/**
 * Which OPTIONAL request parameters an upstream 4xx is complaining about.
 *
 * ## Why this module exists
 *
 * A dialect that forwards a parameter speculatively needs a way back when the
 * relay does not know it. The alternative — withholding the parameter from
 * every endpoint that cannot be *proven* to accept it — fails silently: the
 * caller's `stop_sequences` simply stop working and nothing says so. Sending it
 * fails loudly, once, and is repaired in a single round-trip
 * (`ComposedHandler` bounds the recovery to one attempt).
 *
 * That is the same trade `grok-effort-support.ts` documents for
 * `reasoning_effort`. This module is its general form, used by
 * {@link BaseAPIFormat.recoverFromRejection} for the parameters the OpenAI-shaped
 * payload builders add.
 *
 * ## The detection is deliberately narrow
 *
 * Two gates must BOTH pass before a parameter is called rejected:
 *
 *  1. the body reads as a complaint about a parameter at all, and
 *  2. the parameter name occupies a *field* position in it — quoted, named as a
 *     parameter/argument/field/property, or leading its own message.
 *
 * Gate 2 is what keeps `stop` — an ordinary English word — from matching prose.
 * A body that merely contains the word (`"please stop retrying"`) names no
 * field and is not a rejection. When in doubt this returns nothing: a missed
 * recovery costs one failed request the user can see, while a wrong one silently
 * strips a parameter the model did accept.
 *
 * **Provenance of the shapes below**: they are the documented/known error
 * wordings of OpenAI-compatible relays (OpenAI, vLLM, xAI, Anthropic-shaped
 * validators), written here from the field names they use — NOT captured from a
 * live 4xx in this repo. The tests pin the wordings, not any provider's promise
 * to keep using them.
 */

/**
 * The body reads as a complaint about a request parameter.
 *
 * Checked before any name match so that an unrelated 4xx (rate limit, auth,
 * content filter) can never strip a parameter.
 */
const PARAMETER_COMPLAINT =
  /(unknown|unrecognized|unexpected|unsupported|not supported|does not support|invalid|not permitted|not allowed|extra (fields|inputs))/i;

/** Regex-escape a parameter name so a dotted name cannot act as a wildcard. */
function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `errorText` name `param` in a FIELD position (not as prose)?
 *
 * Three accepted forms, each seen in the wild:
 *   · quoted — `Unexpected keyword argument 'stop'`
 *   · introduced — `Unrecognized request argument supplied: stop`,
 *     `does not support parameter top_p`
 *   · leading its own message — `{"message":"stop: Extra inputs are not permitted"}`
 */
function namesParameterField(errorText: string, param: string): boolean {
  const p = escapeName(param);
  const tail = "(?![A-Za-z0-9_])";
  const quoted = new RegExp(`['"\`]${p}['"\`]`);
  // `argument supplied: stop` / `does not support parameter top_p`: the noun,
  // then at most a few connector words, then the name. The connectors are an
  // allowlist rather than "any 40 characters" so that a complaint about some
  // OTHER field cannot reach across into a prose use of ours.
  const introduced = new RegExp(
    "(?:parameter|argument|field|property|key|input)s?\\b" +
      "(?:[^A-Za-z0-9_]|\\b(?:supplied|provided|given|named|name|is|was|of|in|the|for|body|request|json)\\b){0,6}" +
      `${p}${tail}`,
    "i"
  );
  // Start of the body, or start of a quoted JSON string value.
  const leading = new RegExp(`(?:^|["'])\\s*${p}\\s*:`);
  return quoted.test(errorText) || introduced.test(errorText) || leading.test(errorText);
}

/**
 * The subset of `candidates` this error body rejects, in the given order.
 *
 * Empty when the body is not a parameter complaint, or names none of them.
 */
export function rejectedOptionalParams(errorText: string, candidates: readonly string[]): string[] {
  if (!errorText || !PARAMETER_COMPLAINT.test(errorText)) return [];
  return candidates.filter((param) => namesParameterField(errorText, param));
}
