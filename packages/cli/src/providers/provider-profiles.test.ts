import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviderByName, toRemoteProvider } from "./provider-definitions.js";
import { createHandlerForProvider } from "./provider-profiles.js";

// The composition table must not read the ambient ~/.claudish/all-models.json.
const fixtureDir = mkdtempSync(join(tmpdir(), "provider-profiles-"));
const catalogCachePath = join(fixtureDir, "all-models.json");

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

writeFileSync(
  catalogCachePath,
  JSON.stringify({
    version: 2,
    lastUpdated: new Date().toISOString(),
    entries: [
      {
        modelId: "acme-responses-x1.0",
        aliases: [],
        sources: {},
        endpoints: {
          openai: { api: "responses", toolsWithReasoning: "requires-responses" },
        },
        tokenParam: "max_output_tokens",
      },
    ],
    models: [],
  })
);

interface Composition {
  transport: string;
  streamFormat: string;
  endpoint: string;
}

async function describeHandler(providerName: string, modelName: string): Promise<Composition> {
  const def = getProviderByName(providerName)!;
  const handler: any = await createHandlerForProvider({
    provider: toRemoteProvider(def),
    modelName,
    apiKey: "test-key",
    targetModel: modelName,
    port: 1234,
    sharedOpts: {},
    catalogCachePath,
  } as any);

  return handler.describeComposition();
}

const expectedCompositions = [
  {
    provider: "opencode-zen-go",
    model: "minimax-m2.5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
  },
  {
    provider: "opencode-zen-go",
    model: "glm-5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
  },
  {
    provider: "opencode-zen-go",
    model: "gpt-5.6-luna",
    streamFormat: "openai-responses-sse",
    endpoint: "https://opencode.ai/zen/go/v1/responses",
  },
  {
    provider: "opencode-zen",
    model: "minimax-m2.5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
  },
  {
    provider: "opencode-zen",
    model: "glm-5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
  },
  {
    provider: "opencode-zen",
    model: "gpt-5.6-luna",
    streamFormat: "openai-responses-sse",
    endpoint: "https://opencode.ai/zen/v1/responses",
  },
] as const;

describe("OpenCode Zen provider composition", () => {
  for (const row of expectedCompositions) {
    test(`${row.provider} ${row.model} uses ${row.streamFormat} at ${row.endpoint}`, async () => {
      expect(await describeHandler(row.provider, row.model)).toEqual({
        transport: row.provider,
        streamFormat: row.streamFormat,
        endpoint: row.endpoint,
      });
    });
  }

  for (const provider of ["opencode-zen-go", "opencode-zen"] as const) {
    test(`${provider} pairs MiniMax's OpenAI format with its chat-completions endpoint`, async () => {
      const composition = await describeHandler(provider, "minimax-m2.5");

      // An Anthropic format paired with a chat-completions endpoint is the exact
      // mismatch that produced the 400. This pins the PAIRING, not either field alone.
      expect(composition.streamFormat).not.toBe("anthropic-sse");
      expect(composition.endpoint.endsWith("/v1/chat/completions")).toBe(true);
    });

    test(`${provider} gives MiniMax the same composition as an ordinary chat model`, async () => {
      expect(await describeHandler(provider, "minimax-m2.5")).toEqual(
        await describeHandler(provider, "glm-5")
      );
    });

    // The deleted special case used a case-insensitive MiniMax substring match,
    // so both casing changes and future MiniMax model ids must remain ordinary.
    for (const model of ["MiniMax-M2.5", "minimax-m3"] as const) {
      test(`${provider} has no resurrected MiniMax special case for ${model}`, async () => {
        expect(await describeHandler(provider, model)).toEqual(
          await describeHandler(provider, "minimax-m2.5")
        );
      });
    }
  }
});

describe("OpenAI Responses-API gate", () => {
  const responsesComposition = {
    transport: "openai",
    streamFormat: "openai-responses-sse",
    endpoint: "https://api.openai.com/v1/responses",
  } as const;
  const chatCompletionsComposition = {
    transport: "openai",
    streamFormat: "openai-sse",
    endpoint: "https://api.openai.com/v1/chat/completions",
  } as const;
  const openAICompositionCases = [
    { model: "acme-responses-x1.0", expected: responsesComposition },
    { model: "gpt-5.3-codex", expected: responsesComposition },
    { model: "gpt-5-codex", expected: responsesComposition },
    { model: "gpt-5.1-codex-max", expected: responsesComposition },
    { model: "gpt-5.1-codex-mini", expected: responsesComposition },
    { model: "GPT-5.1-CODEX-MINI", expected: responsesComposition },
    { model: "gpt-5.6-luna", expected: responsesComposition },
    { model: "gpt-5.6-sol", expected: responsesComposition },
    { model: "gpt-5.4", expected: chatCompletionsComposition },
    { model: "gpt-5.5", expected: chatCompletionsComposition },
    { model: "gpt-4o", expected: chatCompletionsComposition },
    { model: "gpt-5", expected: chatCompletionsComposition },
    { model: "gpt-5-mini", expected: chatCompletionsComposition },
  ] as const;

  for (const row of openAICompositionCases) {
    test(`openai ${row.model} uses ${row.expected.streamFormat} at ${row.expected.endpoint}`, async () => {
      expect(await describeHandler("openai", row.model)).toEqual(row.expected);
    });
  }

  test("a codex id routes to Responses regardless of where 'codex' appears in the name", async () => {
    expect(await describeHandler("openai", "codex-mini-latest")).toEqual(responsesComposition);
  });

  test("a codex id gets a Responses body AND a Responses endpoint (the two layers must agree)", async () => {
    for (const model of ["gpt-5.4-codex", "gpt-5.3-codex", "codex-mini-latest"]) {
      const composition = await describeHandler("openai", model);

      // The endpoint already follows the codex rule in transport/openai.ts:31,37;
      // streamFormat is what catches drift in the profile adapter choice.
      expect(composition.streamFormat).toBe("openai-responses-sse");
      expect(composition.endpoint.endsWith("/v1/responses")).toBe(true);
    }
  });

  test("a non-codex model keeps both layers on Chat Completions", async () => {
    const composition = await describeHandler("openai", "gpt-5.4");

    expect(composition.streamFormat).toBe("openai-sse");
    expect(composition.endpoint.endsWith("/v1/chat/completions")).toBe(true);
  });

  test("openai-codex remains Responses-only for codex and non-codex ids", async () => {
    const expected = { ...responsesComposition, transport: "openai-codex" };

    // This provider composes to Responses by construction, so the `openai` gate is not what decides it.
    expect(await describeHandler("openai-codex", "gpt-5.3-codex")).toEqual(expected);
    expect(await describeHandler("openai-codex", "gpt-4o")).toEqual(expected);
  });
});
