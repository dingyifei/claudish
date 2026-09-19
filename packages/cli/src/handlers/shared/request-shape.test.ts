import { describe, expect, test } from "bun:test";
import { getRecoveryHint } from "../composed-handler.js";
import {
  buildSurfacedErrorMessage,
  extractUpstreamStatus,
  isTerminalError,
  wrapAnthropicError,
} from "./anthropic-error.js";
import {
  CONTEXT_OVERFLOW_PHRASE,
  isContextOverflowError,
  isRequestShapeError,
} from "./request-shape.js";

const unknownParameter = `{"error":{"message":"Unknown parameter: 'max_output_tokens'.","type":"invalid_request_error","param":"max_output_tokens","code":"unknown_parameter"}}`;
const unsupportedParameter = `{"error":{"message":"Unsupported parameter: 'messages'. In the Responses API, this parameter has moved to 'input'.","type":"invalid_request_error","param":"messages","code":"unsupported_parameter"}}`;
const contextOverflow = `{"error":{"message":"This model's maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}`;

describe("request-shape classification and recovery hints", () => {
  test("A: recognizes the measured unknown parameter body", () => {
    expect(isRequestShapeError(unknownParameter)).toBe(true);
  });

  test("B: recognizes the Responses API unsupported parameter body", () => {
    expect(isRequestShapeError(unsupportedParameter)).toBe(true);
  });

  test("C: does not classify genuine context overflow as a parameter error", () => {
    expect(isRequestShapeError(contextOverflow)).toBe(false);
  });

  test("D: does not classify an empty body as a parameter error", () => {
    expect(isRequestShapeError("")).toBe(false);
  });

  test("E: parameter rejection advises about the parameter, not input size", () => {
    const hint = getRecoveryHint(400, unknownParameter, "OpenAI");
    expect(hint).not.toContain("Input too large");
    expect(hint.toLowerCase()).toMatch(/\bparameter\b/);
  });

  test("F: genuine context overflow retains the input size hint", () => {
    expect(getRecoveryHint(400, contextOverflow, "OpenAI")).toContain("Input too large");
  });

  test("G: an unclassified 400 retains the generic format hint", () => {
    expect(getRecoveryHint(400, '{"error":{"message":"bad request"}}', "OpenAI")).toBe(
      "Request format may be incompatible with provider."
    );
  });
});

/**
 * Item 8 — a context overflow must reach the client wearing the phrase the
 * client matches.
 *
 * The provider bodies below reuse the shapes the sibling tests above already
 * use, plus the structured codes named in `adapters.md`'s "read the code, not
 * the prose" rule. None of them is a captured live 4xx: they are written from
 * documented relay shapes, and are labelled as such here for the same reason the
 * `stop`/`top_p` rejection wordings in this batch are.
 */
const requestTooLarge = `{"error":{"message":"Request too large for gpt-5.4 in organization org-x on tokens per min (TPM): Limit 30000, Requested 40000.","type":"tokens","code":"request_too_large"}}`;
const anthropicOverflow = `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens exceed the 200000 maximum"}}`;
const payloadTooLarge = `{"error":{"message":"Payload too large: the prompt exceeds the context window of this model"}}`;
const maxTokensComplaint = `{"error":{"message":"max_tokens: the answer must be at most 8192 tokens","type":"invalid_request_error","code":"invalid_request_error"}}`;
const unrelated400 = `{"error":{"message":"bad request"}}`;
const bigFile413 = `{"error":{"message":"uploaded file is too big"}}`;

describe("context-overflow classification (item 8)", () => {
  test("H: the provider's structured code is read first", () => {
    expect(isContextOverflowError(400, contextOverflow)).toBe(true);
    expect(isContextOverflowError(400, requestTooLarge)).toBe(true);
  });

  test("I: prose is matched when a gateway dropped the code", () => {
    const proseOnly = `{"error":{"message":"This model's maximum context length is 128000 tokens."}}`;
    expect(isContextOverflowError(400, proseOnly)).toBe(true);
    expect(isContextOverflowError(400, anthropicOverflow)).toBe(true);
  });

  test("J: a PARAMETER rejection is never an overflow, whatever words it uses", () => {
    // The ordering guard. `max_output_tokens` contains "tokens"; inverting this
    // re-opens the bug adapters.md records, where a parameter rejection was
    // rendered as advice to shorten a prompt that was never too long.
    expect(isContextOverflowError(400, unknownParameter)).toBe(false);
    expect(isContextOverflowError(400, unsupportedParameter)).toBe(false);
    // This is where the guard is actually load-bearing rather than
    // belt-and-braces: at 400 none of the phrase arms can match a parameter
    // rejection anyway, but the 413 arm only asks the body to mention "token",
    // and `max_output_tokens` does. Deleting the guard flips this line alone.
    expect(isContextOverflowError(413, unknownParameter)).toBe(false);
  });

  test("K: an output-length complaint is not an input overflow", () => {
    expect(isContextOverflowError(400, maxTokensComplaint)).toBe(false);
  });

  test("L: an empty or unrelated body is not an overflow", () => {
    expect(isContextOverflowError(400, "")).toBe(false);
    expect(isContextOverflowError(400, unrelated400)).toBe(false);
    expect(isContextOverflowError(500, `{"error":{"message":"internal"}}`)).toBe(false);
  });

  test("M: a 413 naming the prompt is an overflow; a 413 naming something else is not", () => {
    expect(isContextOverflowError(413, payloadTooLarge)).toBe(true);
    expect(isContextOverflowError(413, bigFile413)).toBe(false);
  });

  test("N: a 413 overflow now gets the size hint instead of 'Unexpected HTTP 413'", () => {
    expect(getRecoveryHint(413, payloadTooLarge, "OpenAI")).toContain("Input too large");
    expect(getRecoveryHint(413, bigFile413, "OpenAI")).toBe("Unexpected HTTP 413 from OpenAI.");
  });
});

describe("the surfaced overflow message (item 8)", () => {
  test("O: an overflow is terminal, so it takes the 400-remap path", () => {
    expect(isTerminalError(400, contextOverflow, false)).toBe(true);
    expect(isTerminalError(413, payloadTooLarge, false)).toBe(true);
    // Unchanged: an ordinary 400 is still not terminal.
    expect(isTerminalError(400, unrelated400, false)).toBe(false);
    // Unchanged: a parameter rejection is still not terminal.
    expect(isTerminalError(400, unknownParameter, false)).toBe(false);
  });

  test("P: the phrase LEADS the surfaced line", () => {
    const message = buildSurfacedErrorMessage({
      providerDisplayName: "OpenAI",
      status: 400,
      hint: getRecoveryHint(400, contextOverflow, "OpenAI"),
      providerMessage: "This model's maximum context length is 128000 tokens.",
      leadPhrase: CONTEXT_OVERFLOW_PHRASE,
    });
    // startsWith, not includes: sanitizeErrorMessage caps the line at 600 chars,
    // and the client's own message classifier tests the prefix.
    expect(message.startsWith(CONTEXT_OVERFLOW_PHRASE)).toBe(true);
    expect(message).toContain("OpenAI error (HTTP 400)");
    expect(message).toContain("Input too large");
  });

  test("Q: the phrase survives sanitization at the 600-char cap", () => {
    const envelope = wrapAnthropicError(
      400,
      buildSurfacedErrorMessage({
        providerDisplayName: "OpenAI",
        status: 400,
        hint: getRecoveryHint(400, contextOverflow, "OpenAI"),
        providerMessage: "x".repeat(5000),
        leadPhrase: CONTEXT_OVERFLOW_PHRASE,
      }),
      "invalid_request_error",
      400
    );
    expect(envelope.error.message.startsWith(CONTEXT_OVERFLOW_PHRASE)).toBe(true);
    expect(envelope.error.message.length).toBeLessThanOrEqual(600);
  });

  test("R: the 400-remap contract is intact — upstream_status is recoverable", () => {
    const envelope = wrapAnthropicError(
      400,
      `${CONTEXT_OVERFLOW_PHRASE} — OpenAI error (HTTP 413)`,
      "invalid_request_error",
      413
    );
    expect(envelope.error.upstream_status).toBe(413);
    expect(extractUpstreamStatus(JSON.stringify(envelope))).toBe(413);
  });

  test("S: a non-overflow terminal error is unchanged — no phrase is added", () => {
    const message = buildSurfacedErrorMessage({
      providerDisplayName: "Sakana Fugu",
      status: 401,
      hint: "Check API key / OAuth credentials.",
      providerMessage: "invalid api key",
    });
    expect(message).toBe(
      "Sakana Fugu error (HTTP 401): Check API key / OAuth credentials. — invalid api key"
    );
  });
});
