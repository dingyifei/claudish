import { describe, expect, test } from "bun:test";
import type { AggregatorEntry } from "../model-loader.js";
import {
  type ConnectionPrice,
  compareByConnectionPrice,
  connectionPrice,
} from "./connection-price.js";

type Pricing = AggregatorEntry["pricing"];

// Trimmed verbatim from the local live cloud models catalog generation
// g-20260920154425586-418ad3dd. That generation predates the discriminator
// rename, so these source rows intentionally retain its published `shape` field.
const liveRows = {
  deepseekFlat: {
    modelId: "deepseek-v4.1-flash",
    route: { routeId: "ollama", routeProfileId: "cloud" },
    externalModelId: "deepseek-v4.1-flash:cloud",
    pricing: { shape: "flat", input: 0.3, output: 1.2, cachedRead: 0.006 },
  },
  qwenFirstTier: {
    modelId: "qwen3.7-flash",
    route: { routeId: "qwen", routeProfileId: "dashscope-direct" },
    externalModelId: "qwen3.7-flash",
    pricing: {
      shape: "tiered",
      input: 0.03,
      output: 0.13,
      tiers: [
        {
          maxInputTokens: 32000,
          input: 0.03,
          output: 0.13,
          cachedRead: 0.006,
          cachedWrite: 0.038,
        },
        {
          maxInputTokens: 256000,
          input: 0.1,
          output: 0.4,
          cachedRead: 0.02,
          cachedWrite: 0.125,
        },
        {
          maxInputTokens: 1000000,
          input: 0.2,
          output: 0.8,
          cachedRead: 0.04,
          cachedWrite: 0.25,
        },
      ],
      cachedRead: 0.006,
      cachedWrite: 0.038,
    },
  },
  perplexityEmbedding: {
    modelId: "pplx-embed-v1-0.6b",
    route: { routeId: "openrouter", routeProfileId: "gateway" },
    externalModelId: "perplexity/pplx-embed-v1-0.6b",
    pricing: { shape: "flat", input: 0.004, output: 0 },
  },
  nexFree: {
    modelId: "nex-n2.5-mini",
    route: { routeId: "openrouter", routeProfileId: "gateway" },
    externalModelId: "nex-agi/nex-n2.5-mini:free",
    pricing: { shape: "flat", input: 0, output: 0 },
  },
  qwenUnavailable: {
    modelId: "qwen3.8-omni-flash",
    route: { routeId: "qwen", routeProfileId: "dashscope-direct" },
    externalModelId: "qwen3.8-omni-flash",
    pricing: { shape: "unavailable" },
  },
} as const;

// Trimmed verbatim from the `glm-5.3-fp8` Together AI connection in live
// generation g-20260921062451697-f490edba. Its published flat 0/0 price is the
// measured catalog defect this regression protects against.
const liveTogetherUnmeasured = {
  modelId: "glm-5.3-fp8",
  route: { routeId: "together-ai", routeProfileId: "gateway" },
  externalModelId: "zai-org/GLM-5.3-FP8",
  pricing: { type: "flat", input: 0, output: 0 },
} as const;

// The implementation notes record g-20260921062451697-f490edba as the live
// cutover to `type`, including 30 `free` connections. These inputs project that
// new discriminator onto the real identities and rates captured above.
const livePrices = {
  deepseekFlat: {
    type: "flat",
    input: liveRows.deepseekFlat.pricing.input,
    output: liveRows.deepseekFlat.pricing.output,
    cachedRead: liveRows.deepseekFlat.pricing.cachedRead,
  },
  qwenFirstTier: {
    type: "tiered",
    input: liveRows.qwenFirstTier.pricing.input,
    output: liveRows.qwenFirstTier.pricing.output,
    tiers: liveRows.qwenFirstTier.pricing.tiers.map((tier) => ({ ...tier })),
    cachedRead: liveRows.qwenFirstTier.pricing.cachedRead,
    cachedWrite: liveRows.qwenFirstTier.pricing.cachedWrite,
  },
  perplexityEmbedding: {
    type: "flat",
    input: liveRows.perplexityEmbedding.pricing.input,
    output: liveRows.perplexityEmbedding.pricing.output,
  },
  nexFree: { type: "free" },
  unavailable: { type: "unavailable" },
} satisfies Record<string, NonNullable<Pricing>>;

// Verbatim pre-cutover pricing from deepseek-v4.1-flash on
// the (ollama, cloud) route binding in g-20260920154425586-418ad3dd. It
// deliberately has usable numbers but no `type`; connectionPrice must not
// treat `shape` as an alias.
const livePriceWithoutType = {
  ...liveRows.deepseekFlat.pricing,
} as unknown as Pricing;

const unknownPrice: ConnectionPrice = { known: false, label: "unknown" };

describe("connectionPrice", () => {
  test("flat pricing sums the live input and output rates", () => {
    expect(connectionPrice(livePrices.deepseekFlat)).toEqual({
      known: true,
      perMillionTokens: 1.5,
      label: "$1.50/M",
    });
  });

  test("a live Together AI connection with an unmeasured price is unknown", () => {
    expect(connectionPrice(liveTogetherUnmeasured.pricing)).toEqual(unknownPrice);
  });

  test.each([
    ["free input and paid output", { type: "flat", input: 0, output: 5 }],
    ["paid input and free output", { type: "flat", input: 5, output: 0 }],
  ] as const)("a flat price with %s remains known", (_case, pricing) => {
    expect(connectionPrice(pricing)).toEqual({
      known: true,
      perMillionTokens: 5,
      label: "$5.00/M",
    });
  });

  test("a live free connection is a known zero price", () => {
    expect(connectionPrice(livePrices.nexFree)).toEqual({
      known: true,
      perMillionTokens: 0,
      label: "free",
    });
  });

  test("tiered pricing uses the first live qwen3.7-flash tier, never the mean", () => {
    const result = connectionPrice(livePrices.qwenFirstTier);

    expect(result).toEqual({
      known: true,
      perMillionTokens: 0.16,
      label: "$0.16/M (first tier)",
    });
    expect(result.known && result.perMillionTokens).not.toBeCloseTo((0.16 + 0.5 + 1) / 3, 10);
    expect(result.known && result.perMillionTokens).not.toBe(0.5);
    expect(result.known && result.perMillionTokens).not.toBe(1);
  });

  // Contract-only case: generation g-20260921062451697-f490edba has no tiered
  // connection whose first tier sums to zero.
  test("a tiered price with an unmeasured first-tier price is unknown", () => {
    expect(
      connectionPrice({
        type: "tiered",
        input: 0,
        output: 0,
        tiers: [{ maxInputTokens: 32000, input: 0, output: 0 }],
      })
    ).toEqual(unknownPrice);
  });

  // Contract-only fallback cases from connection-price.md. The live tiered rows
  // in g-20260921062451697-f490edba all publish a usable first tier.
  test.each([
    ["missing tiers", undefined],
    ["empty tiers", []],
    ["malformed first tier", [{ maxInputTokens: 32000, input: 0.03 }]],
  ])("tiered pricing with %s falls back to the top-level first-tier rates", (_case, tiers) => {
    expect(connectionPrice({ type: "tiered", input: 0.03, output: 0.13, tiers })).toEqual({
      known: true,
      perMillionTokens: 0.16,
      label: "$0.16/M (first tier)",
    });
  });

  test("a live sub-cent price never renders as zero", () => {
    expect(connectionPrice(livePrices.perplexityEmbedding)).toEqual({
      known: true,
      perMillionTokens: 0.004,
      label: "$0.004/M",
    });
  });

  test("unavailable pricing is unknown", () => {
    expect(connectionPrice(livePrices.unavailable)).toEqual(unknownPrice);
  });

  test("usable numbers without type remain unknown", () => {
    expect(connectionPrice(livePriceWithoutType)).toEqual(unknownPrice);
  });

  test("a live connection with no pricing object is unknown", () => {
    expect(connectionPrice(undefined)).toEqual(unknownPrice);
  });

  // Contract-only forward-compatibility case from connection-price.md; the two
  // cited live generations publish only flat, tiered, free and unavailable.
  test("an unrecognised type is unknown rather than guessed or thrown", () => {
    const futurePricing = { type: "future", input: 0.3, output: 1.2 } as unknown as Pricing;
    expect(connectionPrice(futurePricing)).toEqual(unknownPrice);
  });

  // Contract-only malformed-flat cases from connection-price.md; no live row in
  // g-20260921062451697-f490edba omits one side of a declared flat price.
  test.each([
    ["input", { type: "flat", output: 1.2 }],
    ["output", { type: "flat", input: 0.3 }],
    ["both rates", { type: "flat" }],
  ] as const)("a flat price missing %s is unknown", (_case, pricing) => {
    expect(connectionPrice(pricing)).toEqual(unknownPrice);
  });

  // Contract-only invalid-number cases from the agreed no-sentinel rule in
  // connection-price.md. The cited live generations publish no such rates.
  test.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("a flat price with a %s rate is unknown", (_case, input) => {
    expect(connectionPrice({ type: "flat", input, output: 0 })).toEqual(unknownPrice);
  });

  // Contract-only malformed-tier case from connection-price.md; no cited live
  // tiered row lacks both a usable first tier and a usable top-level pair.
  test("a tiered price with no usable first-tier or top-level pair is unknown", () => {
    expect(connectionPrice({ type: "tiered", input: 0.03, tiers: [{ input: 0.03 }] })).toEqual(
      unknownPrice
    );
  });

  test("unknown results are fresh objects", () => {
    const first = connectionPrice(undefined);
    const second = connectionPrice(undefined);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

describe("compareByConnectionPrice", () => {
  test("known prices sort ascending", () => {
    const cheap = connectionPrice(livePrices.perplexityEmbedding);
    const expensive = connectionPrice(livePrices.deepseekFlat);
    expect(compareByConnectionPrice(cheap, expensive)).toBeLessThan(0);
    expect(compareByConnectionPrice(expensive, cheap)).toBeGreaterThan(0);
  });

  test("unknown never outranks a priced connection", () => {
    const priced = connectionPrice(livePrices.qwenFirstTier);
    const unavailable = connectionPrice(livePrices.unavailable);
    expect(compareByConnectionPrice(priced, unavailable)).toBeLessThan(0);
    expect(compareByConnectionPrice(unavailable, priced)).toBeGreaterThan(0);
  });

  test("a genuinely free connection sorts before every paid connection", () => {
    const free = connectionPrice(livePrices.nexFree);
    const paid = connectionPrice(livePrices.perplexityEmbedding);
    expect(compareByConnectionPrice(free, paid)).toBeLessThan(0);
  });

  test("an unmeasured Together AI price cannot sort ahead of a genuinely free connection", () => {
    const unmeasured = connectionPrice(liveTogetherUnmeasured.pricing);
    const free = connectionPrice(livePrices.nexFree);
    expect(compareByConnectionPrice(unmeasured, free)).toBeGreaterThan(0);
  });

  test("a negative sentinel is unknown and cannot sort ahead of free", () => {
    const sentinel = connectionPrice({ type: "flat", input: -1, output: 0 });
    const free = connectionPrice(livePrices.nexFree);
    expect(sentinel).toEqual(unknownPrice);
    expect(compareByConnectionPrice(sentinel, free)).toBeGreaterThan(0);
  });

  test("equal known prices tie exactly", () => {
    const first = connectionPrice({ type: "flat", input: 0.03, output: 0.13 });
    const second = connectionPrice(livePrices.qwenFirstTier);
    expect(compareByConnectionPrice(first, second)).toBe(0);
  });

  test("two unknown prices tie exactly", () => {
    expect(compareByConnectionPrice(connectionPrice(undefined), unknownPrice)).toBe(0);
  });

  test("a realistic mixed list sorts free, then ascending, then stable unknowns", () => {
    const connections = [
      { id: "deepseek-v4.1-flash/deepseek-direct", pricing: livePrices.unavailable },
      { id: "qwen3.7-flash/qwen-direct", pricing: livePrices.qwenFirstTier },
      { id: "nex-n2.5-mini/openrouter", pricing: livePrices.nexFree },
      { id: "qwen3.8-omni-flash/qwen-direct", pricing: livePrices.unavailable },
      { id: "pplx-embed-v1-0.6b/openrouter", pricing: livePrices.perplexityEmbedding },
    ];

    connections.sort((a, b) =>
      compareByConnectionPrice(connectionPrice(a.pricing), connectionPrice(b.pricing))
    );

    expect(connections.map(({ id }) => id)).toEqual([
      "nex-n2.5-mini/openrouter",
      "pplx-embed-v1-0.6b/openrouter",
      "qwen3.7-flash/qwen-direct",
      "deepseek-v4.1-flash/deepseek-direct",
      "qwen3.8-omni-flash/qwen-direct",
    ]);
  });

  test("an all-unknown live list retains caller order", () => {
    const connections = [
      "deepseek-v4.1-flash/deepseek-direct",
      "deepseek-v4.1-flash/fireworks",
      "qwen3.8-omni-flash/qwen-direct",
    ].map((id) => ({ id, price: connectionPrice(livePrices.unavailable) }));

    connections.sort((a, b) => compareByConnectionPrice(a.price, b.price));

    expect(connections.map(({ id }) => id)).toEqual([
      "deepseek-v4.1-flash/deepseek-direct",
      "deepseek-v4.1-flash/fireworks",
      "qwen3.8-omni-flash/qwen-direct",
    ]);
  });
});
