/**
 * BLACK-BOX. Written by `gpt-6-astra` from the spec and a body-stripped `.d.ts`,
 * with no access to this implementation. See
 * `ai-docs/reports/blackbox-tests-alibaba/blackbox-results.md`.
 *
 * DO NOT edit an assertion to make it pass. Its value is that its author had
 * never read the code; a repaired assertion is a regression test, not evidence.
 * Adaptation on integration: import path only.
 */
import { describe, expect, test } from "bun:test";
import { useBlackboxEnv } from "../../test-helpers/blackbox-env.js";
import { hasActionableLink, hasModelUnsupportedWording } from "./model-unsupported.js";

useBlackboxEnv();

describe("unsupported models and invalid keys require different remedies", () => {
  for (const body of [
    "Model not exist",
    JSON.stringify({ error: { message: "Model not exist" } }),
    "Model deepseek-v4-pro-0813 is not supported",
  ]) {
    test(`E1 unsupported wording survives its error envelope: ${body}`, () => {
      expect(hasModelUnsupportedWording(body)).toBe(true);
    });
  }
  for (const body of [
    "InvalidApiKey",
    "invalid access token or token expired",
    "Incorrect API key provided",
  ]) {
    test(`E2 the measured credential rejection is not model exclusion: ${body}`, () => {
      expect(hasModelUnsupportedWording(body)).toBe(false);
    });
  }
  test("E3 a vendor action URL is recognized so a generic key hint need not contradict it", () => {
    const body = JSON.stringify({
      error: {
        type: "RegionError",
        message:
          "The latest version of this model is only available hosted in China and requires explicit opt in: https://opencode.ai/workspace/qa/go",
      },
    });
    expect(hasActionableLink(body)).toBe(true);
    expect(hasModelUnsupportedWording(body)).toBe(false);
  });
  test("E4 a credential error without a link does not pretend to contain an action URL", () => {
    expect(hasActionableLink("Incorrect API key provided")).toBe(false);
  });
});
