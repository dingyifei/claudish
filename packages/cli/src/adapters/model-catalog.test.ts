import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CachedSubscriptionPlan,
  type DiskCacheV2,
  type SlimModelEntry,
  writeAllModelsCache,
} from "../providers/all-models-cache.js";
import {
  lookupModel,
  lookupModelReasoning,
  lookupModelReasoningStatus,
  resolveSubscriptionRouting,
} from "./model-catalog.js";

type VendorPlan = CachedSubscriptionPlan & { provider: string };

let tempDir = "";
let cachePath = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claudish-subscription-routing-"));
  cachePath = join(tempDir, "all-models.json");
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  tempDir = "";
  cachePath = "";
});

function modelEntry(
  modelId: string,
  subscriptionPlans: string[] = [],
  provider?: string,
  externalId: string = modelId
): SlimModelEntry {
  return {
    modelId,
    aliases: [],
    sources: {},
    subscriptionPlans,
    ...(provider
      ? {
          aggregators: [
            {
              provider,
              externalId,
              confidence: "api_official" as const,
            },
          ],
        }
      : {}),
  };
}

function routedPlan(id: string, provider: string, providerUid: string): VendorPlan {
  return {
    id,
    provider,
    modelDiscovery: "catalog",
    routing: { providerUid, nativeModelProviders: [] },
  };
}

function writeCatalog(entries: SlimModelEntry[], plans: CachedSubscriptionPlan[]): void {
  const cache: DiskCacheV2 = {
    version: 2,
    lastUpdated: new Date().toISOString(),
    entries,
    models: [],
    plans,
  };
  writeAllModelsCache(cache, cachePath);
}

describe("resolveSubscriptionRouting", () => {
  test("returns serves only when every Qwen plan sharing the route includes the model", () => {
    writeCatalog(
      [
        modelEntry(
          "qwen3-coder-plus",
          ["alibaba-token-plan-individual", "alibaba-token-plan-team-edition"],
          "qwen-cloud",
          "qwen3-coder-plus-wire"
        ),
      ],
      [
        routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-cloud"),
        routedPlan("alibaba-token-plan-team-edition", "alibaba", "qwen-cloud"),
      ]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-cloud", cachePath)).toEqual({
      kind: "serves",
      externalId: "qwen3-coder-plus-wire",
    });
  });

  test("returns unknown when only some Qwen plans sharing the route include the model", () => {
    writeCatalog(
      [
        modelEntry(
          "qwen3-coder-plus",
          ["alibaba-token-plan-team-edition"],
          "qwen-cloud",
          "qwen3-coder-plus-wire"
        ),
      ],
      [
        routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-cloud"),
        routedPlan("alibaba-token-plan-team-edition", "alibaba", "qwen-cloud"),
      ]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-cloud", cachePath)).toEqual({
      kind: "unknown",
    });
  });

  test("preserves not-served when no Qwen plan includes the model and both rosters are catalog-authoritative", () => {
    writeCatalog(
      [
        modelEntry("qwen3-coder-plus", [], "qwen-cloud"),
        modelEntry("qwen-roster-proof", [
          "alibaba-token-plan-individual",
          "alibaba-token-plan-team-edition",
        ]),
      ],
      [
        routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-cloud"),
        routedPlan("alibaba-token-plan-team-edition", "alibaba", "qwen-cloud"),
      ]
    );

    // This is not a new destructive verdict: the pre-bc7fd79 implementation
    // already returned not-served for a complete, catalog-authoritative view.
    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-cloud", cachePath)).toEqual({
      kind: "not-served",
    });
  });

  test("keeps the v9.0.4 guard: a same-vendor plan without routing forces unknown", () => {
    writeCatalog(
      [
        modelEntry("qwen3-coder-plus", [], "qwen-cloud"),
        modelEntry("qwen3.8-max", ["alibaba-token-plan-individual"]),
      ],
      [
        {
          id: "alibaba-ai-coding-plan",
          provider: "alibaba",
          modelDiscovery: "catalog",
        },
        routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-cloud"),
        routedPlan("alibaba-token-plan-team-edition", "alibaba", "qwen-cloud"),
      ]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-cloud", cachePath)).toEqual({
      kind: "unknown",
    });
  });

  test("returns not-served when the provider plan view is complete and omits the model", () => {
    writeCatalog(
      [modelEntry("glm-4.7", [], "glm-coding"), modelEntry("glm-5.3", ["z-ai-glm-coding-plan"])],
      [routedPlan("z-ai-glm-coding-plan", "z-ai", "glm-coding")]
    );

    expect(resolveSubscriptionRouting("glm-4.7", "glm-coding", cachePath)).toEqual({
      kind: "not-served",
    });
  });

  test("returns serves with the provider external id when the model has plan membership", () => {
    writeCatalog(
      [
        modelEntry(
          "qwen3-coder-plus",
          ["alibaba-token-plan-individual"],
          "qwen-cloud",
          "qwen3-coder-plus-wire"
        ),
      ],
      [routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-cloud")]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-cloud", cachePath)).toEqual({
      kind: "serves",
      externalId: "qwen3-coder-plus-wire",
    });
  });

  test("returns unknown when the provider publishes no membership rows", () => {
    writeCatalog(
      [modelEntry("qwen3-coder-plus", [], "qwen-cloud"), modelEntry("unrelated-model")],
      [routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-cloud")]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-cloud", cachePath)).toEqual({
      kind: "unknown",
    });
  });
});

describe("plan modelDescriptions metadata lookup", () => {
  const describedEntries: SlimModelEntry[] = [
    {
      modelId: "qwen3.8-max-preview",
      aliases: [],
      sources: {},
      contextWindow: 262_144,
      reasoningStatus: "known",
      reasoning: { supported: true, control: "budget", supportsBudgetTokens: true },
    },
    {
      modelId: "qwen3.8-flash-canonical",
      aliases: [],
      sources: {},
      contextWindow: 131_072,
      reasoningStatus: "known",
      reasoning: { supported: true, control: "effort", efforts: ["low", "high"] },
    },
    {
      modelId: "claude-opus-4-5",
      aliases: [],
      sources: {},
      contextWindow: 200_000,
      reasoningStatus: "known",
      reasoning: { supported: true, control: "effort", efforts: ["high", "max"] },
    },
  ];

  function writeDescribedCatalog(): void {
    writeCatalog(describedEntries, [
      {
        id: "future-subscription-plan",
        modelDescriptions: {
          "qwen3.8-max": { status: "described", modelId: "qwen3.8-max-preview" },
          "qwen3.8-flash": { status: "described", modelId: "qwen3.8-flash-canonical" },
          "claude-opus-4-5-20251101": { status: "described", modelId: "claude-opus-4-5" },
        },
      },
    ]);
  }

  test("resolves exact plan wire ids through their different canonical metadata ids", () => {
    writeDescribedCatalog();

    for (const [wireId, canonicalId, contextWindow] of [
      ["qwen3.8-max", "qwen3.8-max-preview", 262_144],
      ["qwen3.8-flash", "qwen3.8-flash-canonical", 131_072],
      ["claude-opus-4-5-20251101", "claude-opus-4-5", 200_000],
    ] as const) {
      expect(lookupModel(wireId, cachePath)).toEqual({
        modelId: canonicalId,
        contextWindow,
        supportsVision: undefined,
        releaseDate: undefined,
      });
      expect(lookupModelReasoningStatus(wireId, cachePath)).toBe("known");
      expect(lookupModelReasoning(wireId, cachePath)?.supported).toBe(true);
    }
  });

  test("treats missing and ambiguous as negative answers without fuzzy matching", () => {
    writeCatalog(
      [
        {
          modelId: "qwen3.9-max-preview",
          aliases: [],
          sources: {},
          contextWindow: 262_144,
          reasoningStatus: "known",
          reasoning: { supported: true, control: "budget" },
        },
        {
          modelId: "qwen3.9-flash-preview",
          aliases: [],
          sources: {},
          contextWindow: 131_072,
          reasoningStatus: "known",
          reasoning: { supported: true, control: "effort", efforts: ["high"] },
        },
      ],
      [
        {
          id: "future-subscription-plan",
          modelDescriptions: {
            "qwen3.9-max": { status: "missing" },
            "qwen3.9-flash": { status: "ambiguous" },
          },
        },
      ]
    );

    for (const wireId of ["qwen3.9-max", "qwen3.9-flash"]) {
      expect(lookupModel(wireId, cachePath)).toBeUndefined();
      expect(lookupModelReasoning(wireId, cachePath)).toBeUndefined();
      expect(lookupModelReasoningStatus(wireId, cachePath)).toBeUndefined();
    }
  });

  test("keeps old caches without modelDescriptions working through ids and aliases", () => {
    writeCatalog(
      [
        {
          modelId: "legacy-canonical-model",
          aliases: ["legacy-wire-model"],
          sources: {},
          contextWindow: 98_304,
          reasoning: { supported: true, control: "toggle" },
        },
      ],
      [{ id: "legacy-plan" }]
    );

    expect(lookupModel("legacy-canonical-model", cachePath)?.contextWindow).toBe(98_304);
    expect(lookupModel("legacy-wire-model", cachePath)?.modelId).toBe("legacy-canonical-model");
    expect(lookupModelReasoningStatus("legacy-wire-model", cachePath)).toBe("known");
  });
});

describe("lookupModelReasoningStatus", () => {
  test("preserves explicit and legacy knowledge without manufacturing a control", () => {
    writeCatalog(
      [
        {
          modelId: "explicit-unknown",
          aliases: [],
          sources: {},
          reasoningStatus: "unknown",
          supportsThinking: true,
        },
        {
          modelId: "explicit-known",
          aliases: [],
          sources: {},
          reasoningStatus: "known",
          reasoning: { supported: false, control: "none" },
        },
        {
          modelId: "legacy-described",
          aliases: [],
          sources: {},
          reasoning: { supported: true, control: "toggle" },
        },
        {
          modelId: "legacy-undescribed",
          aliases: [],
          sources: {},
          supportsThinking: false,
        },
      ],
      [
        {
          id: "negative-plan",
          modelDescriptions: {
            "missing-wire": { status: "missing" },
            "ambiguous-wire": { status: "ambiguous" },
          },
        },
      ]
    );

    expect(lookupModelReasoningStatus("explicit-unknown", cachePath)).toBe("unknown");
    expect(lookupModelReasoning("explicit-unknown", cachePath)).toBeUndefined();
    expect(lookupModelReasoningStatus("explicit-known", cachePath)).toBe("known");
    expect(lookupModelReasoningStatus("legacy-described", cachePath)).toBe("known");
    expect(lookupModelReasoningStatus("legacy-undescribed", cachePath)).toBe("unknown");
    expect(lookupModelReasoning("legacy-undescribed", cachePath)).toBeUndefined();

    for (const modelId of ["not-in-the-catalog", "missing-wire", "ambiguous-wire"]) {
      expect(lookupModelReasoningStatus(modelId, cachePath)).toBeUndefined();
      expect(lookupModelReasoning(modelId, cachePath)).toBeUndefined();
    }
  });
});
