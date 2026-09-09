/**
 * Pins the WIRING, not the helper.
 *
 * `normalizeNativeModelSpec` has its own unit tests, but those stay green if the
 * call is removed from the `--model` parse boundary — which would recreate the
 * original defect: `claudish --model internal` reached Claude Code verbatim and
 * exited 1 with "not a model this version of Claude Code recognizes". These
 * tests fail if the boundary stops normalizing.
 */
import { describe, expect, test } from "bun:test";
import { parseArgs } from "./cli.js";

describe("parseArgs — native selector normalization at the --model boundary", () => {
  test("`--model internal` becomes the tier Claude Code recognises", async () => {
    const config = await parseArgs(["--model", "internal", "hello"]);
    expect(config.model).toBe("opus");
  });

  test("`--model default` becomes the tier too", async () => {
    const config = await parseArgs(["--model", "default", "hello"]);
    expect(config.model).toBe("opus");
  });

  test("an explicit tier is left alone", async () => {
    for (const tier of ["opus", "sonnet", "haiku"]) {
      const config = await parseArgs(["--model", tier, "hello"]);
      expect(config.model).toBe(tier);
    }
  });

  test("an ordinary external model is untouched", async () => {
    // No id is pinned or rewritten by the boundary — only selectors are.
    const config = await parseArgs(["--model", "or@deepseek/deepseek-r1", "hello"]);
    expect(config.model).toBe("or@deepseek/deepseek-r1");
  });

  test("a concrete claude-* id is untouched", async () => {
    const config = await parseArgs(["--model", "claude-sonnet-4-6", "hello"]);
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  test("normalization applies to every link of a model CHAIN", async () => {
    // A chain is the credential-filtered candidate list a parent pins onto a
    // child. A selector surviving in any link would fail at that link.
    const config = await parseArgs(["--model", "internal+or@deepseek/deepseek-r1", "hello"]);
    expect(config.model).toBe("opus");
    expect(config.modelChain).toEqual(["opus", "or@deepseek/deepseek-r1"]);
  });
});
