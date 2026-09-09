import { describe, expect, test } from "bun:test";
import { getRecoveryHint } from "../composed-handler.js";
import { isRequestShapeError } from "./request-shape.js";

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
