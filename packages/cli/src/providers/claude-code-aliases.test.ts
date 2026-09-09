import { describe, expect, test } from "bun:test";
import { claudeCodeTierAlias, normalizeNativeModelSpec } from "./claude-code-aliases.js";

describe("claudeCodeTierAlias", () => {
  test("maps every Claude Code alias to its tier", () => {
    const aliases = [
      ["opus", "opus"],
      ["sonnet", "sonnet"],
      ["haiku", "haiku"],
      ["internal", "opus"],
      ["default", "opus"],
    ] as const;

    for (const [alias, tier] of aliases) {
      expect(claudeCodeTierAlias(alias)).toBe(tier);
    }
  });

  test("ignores case and surrounding whitespace", () => {
    expect(claudeCodeTierAlias(" OPUS ")).toBe("opus");
  });

  test("does not classify concrete model ids as aliases", () => {
    const concreteModelIds = [
      "swe-1.7",
      "some-nonexistent-model-zzz",
      "claude-opus-5",
      "claude-sonnet-5",
      "gpt-5.6-luna",
      "",
    ];

    // A non-null result here would make `--probe` substitute a DIFFERENT
    // working model and report `live` for a name that 404s when runtime sends it
    // verbatim. In particular, a real id that merely contains a tier word, such
    // as `claude-opus-5`, is still a concrete model id, not an alias.
    for (const modelId of concreteModelIds) {
      expect(claudeCodeTierAlias(modelId)).toBeNull();
    }
  });
});

describe("normalizeNativeModelSpec", () => {
  test("rewrites a selector to the tier Claude Code recognises", () => {
    // `claudish --model internal --stdin` exits 1 with
    // [claude-code:unrecognized_model]; `--model opus` exits 0. Measured 2026-08-22.
    expect(normalizeNativeModelSpec("internal")).toBe("opus");
    expect(normalizeNativeModelSpec("default")).toBe("opus");
  });

  test("leaves an explicit tier alone", () => {
    expect(normalizeNativeModelSpec("opus")).toBe("opus");
    expect(normalizeNativeModelSpec("sonnet")).toBe("sonnet");
    expect(normalizeNativeModelSpec("haiku")).toBe("haiku");
  });

  test("does not normalize a selector that is only part of a qualified spec", () => {
    // A mutation that normalized the segment after "@" would pass every simple
    // pass-through example. `or@opus` must stay an OpenRouter spec.
    expect(normalizeNativeModelSpec("or@opus")).toBe("or@opus");
    expect(normalizeNativeModelSpec("vendor@default")).toBe("vendor@default");
    expect(normalizeNativeModelSpec("some/internal")).toBe("some/internal");
  });

  test("near-misses are not selectors", () => {
    expect(normalizeNativeModelSpec("internal-v2")).toBe("internal-v2");
    expect(normalizeNativeModelSpec("opus-4")).toBe("opus-4");
    expect(normalizeNativeModelSpec("default-model")).toBe("default-model");
  });

  test("matches the alias table's case/whitespace contract", () => {
    // claudeCodeTierAlias lowercases and trims, so the normalizer inherits that.
    expect(normalizeNativeModelSpec("Internal")).toBe("opus");
    expect(normalizeNativeModelSpec(" OPUS ")).toBe("opus");
  });

  test("passes concrete ids and provider specs through untouched", () => {
    // No id is pinned by this function — that is what keeps it from rotting the
    // way the probe's hardcoded claude-opus-4-1 default did.
    for (const spec of [
      "claude-sonnet-4-6",
      "gemini-2.0-flash",
      "gpt-4o",
      "or@deepseek/deepseek-r1",
      "ollama@llama3.2:3",
    ]) {
      expect(normalizeNativeModelSpec(spec)).toBe(spec);
    }
  });
});
