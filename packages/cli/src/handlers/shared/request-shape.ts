/**
 * Does this error body blame a PARAMETER rather than the size of the input?
 *
 * `getRecoveryHint` decides what a 400 means from the body, and its
 * context-length test is a substring match on "token". OpenAI's parameter names
 * contain that word, so a request-shape rejection matched the size test and was
 * rendered as advice to shorten the prompt. Measured 2026-09-08 against
 * `oai@gpt-6-astra` with 6.7 KB of input and a 1.05M context window:
 *
 *   400 {"error":{"message":"Unknown parameter: 'max_output_tokens'.",
 *                 "type":"invalid_request_error","param":"max_output_tokens",
 *                 "code":"unknown_parameter"}}
 *
 * The provider states the attribution in `code`. Reading it beats inferring it
 * from prose, and the two disagreed here: the body named a parameter while the
 * hint named the prompt length.
 *
 * Deliberately narrow. A genuine context overflow names a LENGTH, not a
 * parameter — OpenAI's is `code: "context_length_exceeded"`, "This model's
 * maximum context length is N tokens" — and matches nothing below, so widening
 * this predicate is the way to break the size hint that still needs to work.
 *
 * Both the structured code and the prose form are matched, because gateways in
 * front of a vendor frequently forward the message and drop the code field.
 */
export function isRequestShapeError(errorBody: string): boolean {
  if (!errorBody) return false;
  const lower = errorBody.toLowerCase();
  return (
    lower.includes("unknown_parameter") ||
    lower.includes("unsupported_parameter") ||
    lower.includes("invalid_parameter") ||
    lower.includes("unknown parameter:") ||
    lower.includes("unsupported parameter:") ||
    lower.includes("invalid parameter:")
  );
}

/**
 * The literal phrase an Anthropic client pattern-matches to recognise a context
 * overflow.
 *
 * Not decorative and not paraphrasable. Claude Code tests error text for this
 * exact string (verified in the 2.1.273 binary:
 * `n.includes("prompt is too long") || n.includes("input is too long for requested model")`),
 * uses it to classify the turn as `prompt_too_long` rather than a generic
 * invalid request, and parses `prompt is too long[^0-9]*(\d+) tokens? > (\d+)`
 * out of it for the actual/limit numbers it shows the user. A provider that says
 * "This model's maximum context length is 128000 tokens" says the same thing in
 * words no client matches, so the fact is lost in translation unless claudish
 * restates it.
 */
export const CONTEXT_OVERFLOW_PHRASE = "prompt is too long";

/**
 * Did this error say the INPUT was too big for the model's context window?
 *
 * Sibling of `isRequestShapeError`, and deliberately ordered behind it: the two
 * questions are mutually exclusive attributions of the same 400, and a
 * parameter rejection frequently names a parameter with "token" in it. Reading
 * this one first re-opens the `max_output_tokens` bug `adapters.md` records, so
 * the guard is built into the predicate rather than left to each caller to
 * remember.
 *
 * Structured `code` FIRST, prose second — the rule `adapters.md` states as the
 * general lesson of three separate incidents: when the provider ships a
 * structured code, reading it beats inferring from its prose. The prose arm
 * exists only because gateways in front of a vendor routinely forward the
 * message and drop the code.
 *
 * Narrow on purpose. It must not match a rejection that merely MENTIONS length
 * (a `max_tokens` complaint, an oversized image), because every match rewrites
 * the surfaced message into a claim about the prompt.
 */
export function isContextOverflowError(status: number, errorBody: string): boolean {
  if (!errorBody) return false;
  // A parameter rejection is never a size problem, whatever words it uses.
  if (isRequestShapeError(errorBody)) return false;

  const lower = errorBody.toLowerCase();

  // 1. The provider's own structured attribution.
  if (
    lower.includes("context_length_exceeded") ||
    lower.includes("string_above_max_length") ||
    lower.includes("request_too_large") ||
    lower.includes("context_window_exceeded") ||
    lower.includes("prompt_too_long")
  ) {
    return true;
  }

  // 2. Prose, for gateways that drop the code. Each phrase names the INPUT and a
  //    LIMIT together; none of them can be produced by an output-length or
  //    parameter complaint.
  if (
    lower.includes("maximum context length is") ||
    lower.includes("reduce the length of the messages") ||
    lower.includes("input is too long") ||
    lower.includes(CONTEXT_OVERFLOW_PHRASE)
  ) {
    return true;
  }

  // 3. HTTP 413 is "Payload Too Large" by definition. Gated on the body naming
  //    the input at all, so a 413 about an uploaded file is not relabelled as a
  //    prompt problem.
  if (status === 413 && (lower.includes("token") || lower.includes("context"))) return true;

  return false;
}
