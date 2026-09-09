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
