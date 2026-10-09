import { describe, expect, test } from "bun:test";
import { parseModelSpec } from "./model-parser.js";
import { getProviderByName } from "./provider-definitions.js";
import { gatherRouteCandidates } from "./route-candidates.js";

describe("SWE model routing", () => {
  test("auto-detects bare swe-* names as Devin without marking them explicit", () => {
    for (const modelId of ["swe-1.7", "SWE-1.7", "swe-2"]) {
      const parsed = parseModelSpec(modelId);

      expect(parsed.provider).toBe("devin");
      expect(parsed.isExplicitProvider).toBe(false);
    }
  });

  test("Devin claims the swe-* namespace and gathering emits that route candidate", () => {
    const devin = getProviderByName("devin")!;
    expect(devin.nativeModelPatterns?.map(({ pattern }) => pattern.source)).toEqual(["^swe-"]);

    const gathered = gatherRouteCandidates(
      "swe-1.7",
      `${import.meta.dir}/fixtures/intentionally-missing-catalog.json`
    );
    expect(gathered.candidates).toContainEqual({
      provider: "devin",
      wireId: "swe-1.7",
      tier: "dynamic-subscription",
      isVendorOwn: false,
      price: { known: false, label: "unknown" },
      source: "namespace-claim",
    });
  });

  test("never auto-detects Devin's re-served vendor model collisions", () => {
    // Devin re-serves these other vendors' models under colliding UIDs. Auto-detecting
    // a bare name as Devin would let the wrong vendor answer the request.
    for (const modelId of [
      "claude-opus-5-medium",
      "gpt-5-6-luna-medium",
      "glm-5-2",
      "kimi-k3-high",
    ]) {
      expect(parseModelSpec(modelId).provider).not.toBe("devin");
    }
  });

  test("keeps explicit dv@swe-1.7 addressing working", () => {
    const parsed = parseModelSpec("dv@swe-1.7");

    expect(parsed.provider).toBe("devin");
    expect(parsed.model).toBe("swe-1.7");
    expect(parsed.isExplicitProvider).toBe(true);
  });
});
