import { describe, expect, test } from "bun:test";
import {
  classifierPassthroughEnabled,
  isNativeClaudeModelId,
  resolveClassifierConfig,
  resolveClassifierModel,
  rewriteClassifierForNative,
} from "./classifier-passthrough.js";

const emptyEnv: NodeJS.ProcessEnv = {};

// The literal of last resort. Named once here so these tests assert the
// RESOLUTION ORDER rather than re-pinning the model id the feature stopped
// hardcoding — see the catalog test below for the proof it is genuinely derived.
const FALLBACK = "claude-sonnet-5";

describe("isNativeClaudeModelId", () => {
  test("accepts real Anthropic ids", () => {
    expect(isNativeClaudeModelId("claude-sonnet-5")).toBe(true);
    expect(isNativeClaudeModelId("claude-opus-4-8")).toBe(true);
  });

  test("rejects Claude Code's internal tier aliases", () => {
    // parseModelSpec() also calls these "native-anthropic", but api.anthropic.com
    // rejects them — the trap this rule exists to avoid.
    expect(isNativeClaudeModelId("internal")).toBe(false);
    expect(isNativeClaudeModelId("sonnet")).toBe(false);
  });

  test("rejects provider-prefixed and vendor-pathed specs", () => {
    expect(isNativeClaudeModelId("cx@gpt-5.6-sol")).toBe(false);
    expect(isNativeClaudeModelId("anthropic/claude-sonnet-5")).toBe(false);
    expect(isNativeClaudeModelId(undefined)).toBe(false);
    expect(isNativeClaudeModelId("")).toBe(false);
  });
});

describe("resolveClassifierModel — resolution order", () => {
  test("1. the --classifier-model flag wins over everything", () => {
    const model = resolveClassifierModel(
      { classifierModel: "claude-opus-4-8", modelSonnet: "claude-sonnet-4-6" },
      { CLAUDISH_CLASSIFIER_MODEL: "claude-sonnet-4-5" }
    );
    expect(model).toBe("claude-opus-4-8");
  });

  test("2. the env model wins over the sonnet role mapping", () => {
    const model = resolveClassifierModel(
      { modelSonnet: "claude-sonnet-4-6" },
      { CLAUDISH_CLASSIFIER_MODEL: "claude-sonnet-4-5" }
    );
    expect(model).toBe("claude-sonnet-4-5");
  });

  test("3. a sonnet-family --model-sonnet mapping is honoured", () => {
    expect(resolveClassifierModel({ modelSonnet: "claude-sonnet-4-6" }, emptyEnv)).toBe(
      "claude-sonnet-4-6"
    );
  });

  test("3a. a NON-sonnet role mapping is rejected, not used", () => {
    // Mapping the sonnet role to Opus is legal; running the classifier on Opus
    // would be needlessly slow and expensive, so the tier is skipped.
    expect(resolveClassifierModel({ modelSonnet: "claude-opus-4-8" }, emptyEnv)).toBe(FALLBACK);
  });

  test("3b. a foreign-provider role mapping is rejected", () => {
    expect(resolveClassifierModel({ modelSonnet: "cx@gpt-5.6-terra" }, emptyEnv)).toBe(FALLBACK);
  });

  test("3c. Claude Code's internal alias is rejected", () => {
    expect(resolveClassifierModel({ modelSonnet: "internal" }, emptyEnv)).toBe(FALLBACK);
  });

  test("5. falls back to the literal when nothing else resolves", () => {
    expect(resolveClassifierModel({}, emptyEnv)).toBe(FALLBACK);
  });
});

describe("resolveClassifierModel — catalog tier", () => {
  test("4. resolves the catalog's sonnet-latest pointer, whatever it points at", () => {
    // The test that actually demonstrates de-pinning: the catalog names a model
    // id that is NOT the hardcoded fallback, and resolution follows it. If this
    // returned the literal, the "derive it" fix would be cosmetic.
    const model = resolveClassifierModel({}, emptyEnv, {
      lookupAlias: (alias) =>
        alias === "~anthropic/claude-sonnet-latest"
          ? { modelId: "claude-sonnet-9-from-catalog" }
          : null,
    });
    expect(model).toBe("claude-sonnet-9-from-catalog");
  });

  test("an explicit flag still outranks the catalog", () => {
    const model = resolveClassifierModel({ classifierModel: "claude-sonnet-4-6" }, emptyEnv, {
      lookupAlias: () => ({ modelId: "claude-sonnet-9-from-catalog" }),
    });
    expect(model).toBe("claude-sonnet-4-6");
  });

  test("a malformed catalog cache falls through instead of throwing", () => {
    // Catalog entries are cast, not validated, so a structurally bad cache makes
    // the lookup throw. A corrupt cache must never block launch.
    const model = resolveClassifierModel({}, emptyEnv, {
      lookupAlias: () => {
        throw new TypeError("entry.aliases is not iterable");
      },
    });
    expect(model).toBe(FALLBACK);
  });

  test("an empty catalog result falls through to the literal", () => {
    expect(resolveClassifierModel({}, emptyEnv, { lookupAlias: () => null })).toBe(FALLBACK);
  });
});

describe("rewriteClassifierForNative", () => {
  test("forces the model", () => {
    const body: Record<string, unknown> = { model: "claude-opus-4-8" };
    rewriteClassifierForNative(body, "claude-sonnet-5");
    expect(body.model).toBe("claude-sonnet-5");
  });

  test("PRESERVES thinking:disabled — deleting it would turn thinking ON", () => {
    // The captured classifier pairs thinking:{type:"disabled"} with max_tokens:64.
    // Omitting `thinking` makes Claude 5 models run ADAPTIVE thinking, and
    // max_tokens caps thinking + response together — so a deleted field starves
    // the verdict this request exists to produce.
    const body: Record<string, unknown> = {
      model: "claude-sonnet-5",
      max_tokens: 64,
      thinking: { type: "disabled" },
    };
    rewriteClassifierForNative(body, "claude-sonnet-5");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  test("normalises the legacy enabled+budget_tokens shape, which 400s on 5-family models", () => {
    const body: Record<string, unknown> = {
      model: "claude-opus-4-8",
      thinking: { type: "enabled", budget_tokens: 1024 },
    };
    rewriteClassifierForNative(body, "claude-sonnet-5");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  test("leaves an absent thinking field absent", () => {
    const body: Record<string, unknown> = { model: "claude-opus-4-8" };
    rewriteClassifierForNative(body, "claude-sonnet-5");
    expect("thinking" in body).toBe(false);
  });

  test("strips sampling params, which 5-family models reject", () => {
    const body: Record<string, unknown> = {
      model: "claude-opus-4-8",
      temperature: 0,
      top_p: 0.9,
      top_k: 40,
      system: [{ type: "text", text: "keep me" }],
    };
    rewriteClassifierForNative(body, "claude-sonnet-5");
    expect("temperature" in body).toBe(false);
    expect("top_p" in body).toBe(false);
    expect("top_k" in body).toBe(false);
    expect(body.system).toBeDefined();
  });
});

describe("resolveClassifierConfig — enablement", () => {
  test("default OFF when nothing is set", () => {
    expect(resolveClassifierConfig({}, emptyEnv).enabled).toBe(false);
  });

  test("--classifier-provider anthropic enables it", () => {
    expect(resolveClassifierConfig({ classifierProvider: "anthropic" }, emptyEnv).enabled).toBe(
      true
    );
  });

  test("--classifier-model enables it and sets the model", () => {
    const r = resolveClassifierConfig({ classifierModel: "claude-haiku-4-5" }, emptyEnv);
    expect(r).toEqual({ enabled: true, model: "claude-haiku-4-5" });
  });

  test("either env var enables it", () => {
    expect(resolveClassifierConfig({}, { CLAUDISH_CLASSIFIER_PROVIDER: "anthropic" }).enabled).toBe(
      true
    );
    expect(
      resolveClassifierConfig({}, { CLAUDISH_CLASSIFIER_MODEL: "claude-sonnet-4-6" }).enabled
    ).toBe(true);
  });

  test("a non-anthropic provider value does not enable on its own", () => {
    expect(resolveClassifierConfig({ classifierProvider: "openai" }, emptyEnv).enabled).toBe(false);
  });

  test("provider matching is case-insensitive and whitespace-tolerant", () => {
    expect(resolveClassifierConfig({ classifierProvider: "  Anthropic " }, emptyEnv).enabled).toBe(
      true
    );
    expect(resolveClassifierConfig({}, { CLAUDISH_CLASSIFIER_PROVIDER: "ANTHROPIC" }).enabled).toBe(
      true
    );
  });
});

describe("resolveClassifierConfig — the off switch", () => {
  test("--no-classifier-passthrough beats every enabling source", () => {
    const r = resolveClassifierConfig(
      { classifierPassthrough: false, classifierModel: "claude-sonnet-5" },
      { CLAUDISH_CLASSIFIER_PROVIDER: "anthropic", CLAUDISH_CLASSIFIER_MODEL: "claude-sonnet-4-6" }
    );
    expect(r.enabled).toBe(false);
  });

  test("a falsey CLAUDISH_CLASSIFIER_PROVIDER disables an env-model opt-in", () => {
    // The footgun this closes: CLAUDISH_CLASSIFIER_MODEL left in a shell profile
    // would otherwise enable the passthrough for every session, permanently.
    for (const off of ["off", "0", "false", "OFF"]) {
      const r = resolveClassifierConfig(
        {},
        { CLAUDISH_CLASSIFIER_PROVIDER: off, CLAUDISH_CLASSIFIER_MODEL: "claude-sonnet-4-6" }
      );
      expect(r.enabled).toBe(false);
    }
  });

  test("classifierPassthrough:true does NOT enable on its own", () => {
    // The flag is an off switch, not an on switch — enabling still needs a
    // provider or a model, so `true` is a no-op rather than a second trigger.
    expect(resolveClassifierConfig({ classifierPassthrough: true }, emptyEnv).enabled).toBe(false);
  });
});

describe("classifierPassthroughEnabled", () => {
  test("mirrors resolveClassifierConfig().enabled", () => {
    expect(classifierPassthroughEnabled({}, {})).toBe(false);
    expect(classifierPassthroughEnabled({ classifierProvider: "anthropic" }, {})).toBe(true);
    expect(classifierPassthroughEnabled({}, { CLAUDISH_CLASSIFIER_MODEL: "m" })).toBe(true);
  });

  test("does no filesystem work — the auth gate calls it synchronously", () => {
    // A guard against re-coupling enablement to the catalog lookup: if this ever
    // needed disk, isProxyAuthMode() would have to become async.
    const before = resolveClassifierConfig({ classifierProvider: "anthropic" }, emptyEnv);
    expect(classifierPassthroughEnabled({ classifierProvider: "anthropic" }, emptyEnv)).toBe(
      before.enabled
    );
  });
});
