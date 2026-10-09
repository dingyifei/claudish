/**
 * Tests for probe-discovery ranking + fetch helpers.
 *
 * The fetch path is exercised via a mocked global.fetch.
 *
 * Run: bun test src/providers/transport/probe-discovery.test.ts
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiskCacheV3, SlimModelEntry } from "../all-models-cache.js";
import * as __realAllModelsCache from "../all-models-cache.js";

const __realAllModelsCacheExports = { ...__realAllModelsCache };

function chatCatalogEntry(modelId: string): SlimModelEntry {
  return { modelId, aliases: [], outputModalities: ["text"] };
}

const catalogFixture: DiskCacheV3 = {
  version: 3,
  lastUpdated: "2026-09-23T00:00:00.000Z",
  catalogGenerationId: "probe-discovery-test",
  entries: [
    chatCatalogEntry("gpt-4o"),
    chatCatalogEntry("gpt-4o-mini"),
    chatCatalogEntry("claude-haiku-4"),
    chatCatalogEntry("lite-x"),
    chatCatalogEntry("model-a"),
  ],
  models: [],
  plans: [],
};

const modalityFixtureDir = mkdtempSync(join(tmpdir(), "claudish-probe-discovery-"));
const modalityFixturePath = join(modalityFixtureDir, "cloud-models-catalog-v3.json");
__realAllModelsCacheExports.writeAllModelsCache(
  {
    version: 3,
    lastUpdated: "2026-09-23T00:00:00.000Z",
    catalogGenerationId: "probe-discovery-modality-test",
    entries: [
      {
        modelId: "claude-opus-5",
        aliases: [],
        inputModalities: ["file", "image", "text"],
        outputModalities: ["text"],
      },
      {
        modelId: "gpt-realtime-2",
        aliases: [],
        inputModalities: ["audio", "image", "text"],
        outputModalities: ["audio", "text"],
      },
      {
        modelId: "gemini-3.5-transcribe",
        aliases: [],
        inputModalities: ["audio"],
        outputModalities: ["text"],
      },
      {
        modelId: "gpt-realtime-translate",
        aliases: [],
        inputModalities: ["audio"],
        outputModalities: ["audio", "text"],
      },
      { modelId: "inkling", aliases: [], outputModalities: ["text"] },
      {
        modelId: "mistral-medium-2604",
        aliases: [],
        inputModalities: null,
        outputModalities: ["text"],
      },
      {
        modelId: "o3-mini-high",
        aliases: [],
        inputModalities: [],
        outputModalities: ["text"],
      },
      {
        modelId: "gpt-image-2.5-flare",
        aliases: [],
        inputModalities: ["text"],
        outputModalities: ["image"],
      },
    ],
    models: [],
    plans: [],
  },
  modalityFixturePath
);

// OpenAI-compatible listings carry no capability field, so these tests supply
// the catalog evidence that admission uses instead of reading the user's cache.
mock.module("../all-models-cache.js", () => ({
  ...__realAllModelsCacheExports,
  readAllModelsCache: (path?: string) =>
    path ? __realAllModelsCacheExports.readAllModelsCache(path) : catalogFixture,
}));

afterAll(() => {
  mock.module("../all-models-cache.js", () => __realAllModelsCacheExports);
  rmSync(modalityFixtureDir, { recursive: true, force: true });
});

import {
  _clearChatCapabilityIndex,
  _clearProbeDiscoveryCache,
  classifyChatCapability,
  discoverViaLMStudio,
  discoverViaOllama,
  discoverViaOpenAIModels,
  invalidateProbeDiscovery,
  isChatCapable,
  isReportedChatCapable,
  rankProbeCandidates,
} from "./probe-discovery.js";

describe("rankProbeCandidates", () => {
  test("prefers small-name patterns", () => {
    const ranked = rankProbeCandidates([
      "gpt-4o",
      "gpt-4o-mini",
      "llama-70b",
      "llama-3b",
      "claude-opus-4",
      "claude-haiku-4",
    ]);
    // Smalls bubble to the top; alphabetical within group.
    expect(ranked[0]).toBe("claude-haiku-4");
    // Among smalls: claude-haiku-4, gpt-4o-mini, llama-3b
    expect(ranked.slice(0, 3)).toEqual(["claude-haiku-4", "gpt-4o-mini", "llama-3b"]);
  });

  test("falls back to alphabetical when none match heuristics", () => {
    const ranked = rankProbeCandidates(["zoo-model", "alpha-model", "kappa-model"]);
    expect(ranked).toEqual(["alpha-model", "kappa-model", "zoo-model"]);
  });

  test("handles empty input", () => {
    expect(rankProbeCandidates([])).toEqual([]);
  });

  test("recognizes parametric size markers (1b/3b/7b)", () => {
    const ranked = rankProbeCandidates(["model-70b", "model-7b", "model-3b"]);
    expect(ranked[0]).toBe("model-3b");
    expect(ranked[1]).toBe("model-7b");
    expect(ranked[2]).toBe("model-70b"); // doesn't match the small pattern
  });

  test("orders candidates without re-judging capability and drops wildcards", () => {
    expect(rankProbeCandidates(["b-model", "a-model", "gemini/*"])).toEqual(["a-model", "b-model"]);
  });

  test("provider admission excludes an embedding model before ranking", () => {
    const admitted = [
      isReportedChatCapable("vector-model", "not-chat") ? "vector-model" : null,
      isReportedChatCapable("chat-model", "chat") ? "chat-model" : null,
    ].filter((name): name is string => name !== null);

    expect(rankProbeCandidates(admitted)).toEqual(["chat-model"]);
  });

  test("isChatCapable requires positive catalog evidence", () => {
    expect({ known: isChatCapable("gpt-4o"), unknown: isChatCapable("catalog-unknown") }).toEqual({
      known: true,
      unknown: false,
    });
  });

  test("drops wildcard route patterns", () => {
    const ranked = rankProbeCandidates(["gemini/*", "gem-mad/*", "gpt-4o-mini"]);
    expect(ranked).toEqual(["gpt-4o-mini"]);
  });

  test("prefers standard names over deployment-prefixed aliases", () => {
    const ranked = rankProbeCandidates([
      "gem-mad/gemini-flash-latest",
      "oai-10x/gpt-4o-mini",
      "gemini-2.5-flash-lite",
      "gpt-4o-mini",
    ]);
    // Standard names (no slash, or vendor-prefixed) come first; among
    // those, small-name first, then alphabetical.
    expect(ranked.slice(0, 2)).toEqual(["gemini-2.5-flash-lite", "gpt-4o-mini"]);
  });

  test("accepts recognized vendor prefixes as standard", () => {
    const ranked = rankProbeCandidates([
      "gem-mad/foo-mini",
      "openai/gpt-4o-mini",
      "anthropic/claude-haiku",
    ]);
    expect(ranked.slice(0, 2)).toEqual(["anthropic/claude-haiku", "openai/gpt-4o-mini"]);
  });
});

describe("catalog modality evidence", () => {
  test("classifies Claude file/image/text input plus text output as chat", () => {
    expect(classifyChatCapability("claude-opus-5", modalityFixturePath)).toBe("chat");
  });

  test("classifies realtime audio/image/text input plus audio/text output as chat", () => {
    expect(classifyChatCapability("gpt-realtime-2", modalityFixturePath)).toBe("chat");
  });

  test("classifies transcribe audio-only input plus text output as not-chat", () => {
    expect(classifyChatCapability("gemini-3.5-transcribe", modalityFixturePath)).toBe("not-chat");
  });

  test("classifies realtime translation audio-only input plus audio/text output as not-chat", () => {
    expect(classifyChatCapability("gpt-realtime-translate", modalityFixturePath)).toBe("not-chat");
  });

  test("treats absent, null, and empty input lists as silence when text output is published", () => {
    expect(
      ["inkling", "mistral-medium-2604", "o3-mini-high"].map((id) =>
        classifyChatCapability(id, modalityFixturePath)
      )
    ).toEqual(["chat", "chat", "chat"]);
  });

  test("classifies text input plus image-only output as not-chat", () => {
    expect(classifyChatCapability("gpt-image-2.5-flare", modalityFixturePath)).toBe("not-chat");
  });
});

describe("discoverViaOpenAIModels", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    _clearProbeDiscoveryCache();
    // The classifier memoizes its catalog projection across files; drop it so this fixture is read.
    _clearChatCapabilityIndex();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    _clearProbeDiscoveryCache();
    _clearChatCapabilityIndex();
  });

  test("returns smallest model from /v1/models response", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "claude-haiku-4" }],
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const outcome = await discoverViaOpenAIModels(
      "http://litellm.local/v1/models",
      {},
      { key: "test-litellm" }
    );
    expect(outcome.model).toBe("claude-haiku-4");
  });

  test("returns null + http reason on HTTP error", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 503 })
    ) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels("http://x", {}, { key: "test-503" });
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("503");
  });

  test("returns null + empty-list reason on empty model list", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    ) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels(
      "http://localhost:1234/v1/models",
      {},
      { key: "test-empty" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("no models loaded");
  });

  test("classifies localhost ECONNREFUSED with actionable 'is the server running?' hint", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("fetch failed");
      (err as any).cause = { code: "ECONNREFUSED" };
      throw err;
    }) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels(
      "http://localhost:1234/v1/models",
      {},
      { key: "test-refused-local" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("not reachable");
    expect(outcome.reason).toContain("server running");
    expect(outcome.reason).toContain("localhost:1234");
  });

  test("classifies Bun's 'Unable to connect' message even without cause.code", async () => {
    // Bun's actual error shape for localhost refusal — no cause.code field.
    globalThis.fetch = mock(async () => {
      throw new Error("Unable to connect. Is the computer able to access the url?");
    }) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels(
      "http://localhost:1234/v1/models",
      {},
      { key: "test-bun-refused" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("not reachable");
    expect(outcome.reason).toContain("localhost:1234");
  });

  test("remote host ECONNREFUSED suggests checking URL/network", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("fetch failed");
      (err as any).cause = { code: "ECONNREFUSED" };
      throw err;
    }) as unknown as typeof fetch;
    const outcome = await discoverViaOpenAIModels(
      "http://192.168.1.50:1234/v1/models",
      {},
      { key: "test-refused-remote" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("not reachable");
    expect(outcome.reason).toContain("192.168.1.50:1234");
    // Remote variant should mention checking URL/network rather than "is server running"
    expect(outcome.reason).toContain("check");
  });

  test("caches result within TTL", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [{ id: "lite-x" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const a = await discoverViaOpenAIModels("http://x", {}, { key: "cache-test" });
    const b = await discoverViaOpenAIModels("http://x", {}, { key: "cache-test" });
    expect(a.model).toBe("lite-x");
    expect(b.model).toBe("lite-x");
    expect(fetchCount).toBe(1); // second call was cached
  });

  test("invalidateProbeDiscovery drops slug-prefixed cache entries", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await discoverViaOpenAIModels("http://x", {}, { key: "lmstudio:http://localhost:1234" });
    await discoverViaOpenAIModels("http://x", {}, { key: "litellm:http://other" });
    expect(fetchCount).toBe(2);

    // Repeat: both cached, no new fetches
    await discoverViaOpenAIModels("http://x", {}, { key: "lmstudio:http://localhost:1234" });
    await discoverViaOpenAIModels("http://x", {}, { key: "litellm:http://other" });
    expect(fetchCount).toBe(2);

    // Invalidate just lmstudio → next lmstudio call refetches, litellm stays cached
    invalidateProbeDiscovery("lmstudio");
    await discoverViaOpenAIModels("http://x", {}, { key: "lmstudio:http://localhost:1234" });
    await discoverViaOpenAIModels("http://x", {}, { key: "litellm:http://other" });
    expect(fetchCount).toBe(3);
  });
});

describe("discoverViaOllama", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    _clearProbeDiscoveryCache();
    // The classifier memoizes its catalog projection across files; drop it so this fixture is read.
    _clearChatCapabilityIndex();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    _clearProbeDiscoveryCache();
    _clearChatCapabilityIndex();
  });

  const embedderOnlyPsBody =
    '{"models":[{"name":"nomic-embed-text:latest","model":"nomic-embed-text:latest","size":370031984,"capabilities":["embedding"],"digest":"0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f","details":{"parent_model":"","format":"gguf","family":"nomic-bert","families":["nomic-bert"],"parameter_size":"137M","quantization_level":"F16"},"expires_at":"2026-08-03T15:49:20.497918+10:00","size_vram":370031984,"context_length":2048}]}';
  const tagsBody = `{"models":[
 {"name":"nomic-embed-text:latest","size":370031984,"capabilities":["embedding"]},
 {"name":"gemma4:31b-cloud","size":312,"capabilities":["completion"]},
 {"name":"qwen3.5:0.8b-mlx","size":1244127078,"capabilities":["completion","tools"]},
 {"name":"vl-bu-30b-a3b-preview:Q4_K_M","size":19715685721,"capabilities":["completion","vision"]}
]}`;
  const loadedChatPsBody =
    '{"models":[{"name":"vl-bu-30b-a3b-preview:Q4_K_M","size":19715685721,"capabilities":["completion","vision"]}]}';
  const emptyModelsBody = '{"models":[]}';
  const embedderOnlyTagsBody =
    '{"models":[{"name":"nomic-embed-text:latest","size":370031984,"capabilities":["embedding"]}]}';

  function mockOllama(psBody: string, allTagsBody: string) {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/ps") {
        return new Response(psBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (path === "/api/tags") {
        return new Response(allTagsBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
  }

  test("falls through from a loaded embedder to chat models on disk", async () => {
    mockOllama(embedderOnlyPsBody, tagsBody);
    const outcome = await discoverViaOllama("http://localhost:11434", {
      key: "embedder-loaded-tags-chat",
    });
    expect(outcome.model).not.toBeNull();
    expect(outcome.reason ?? "").not.toMatch(/only embedding\/non-chat/);
  });

  test("prefers a loaded chat model over smaller models on disk", async () => {
    mockOllama(loadedChatPsBody, tagsBody);
    const outcome = await discoverViaOllama("http://localhost:11434", {
      key: "loaded-before-smaller-tags",
    });
    expect(outcome.model).toBe("vl-bu-30b-a3b-preview:Q4_K_M");
  });

  test("falls through the cached ranked list when the loaded model is excluded", async () => {
    mockOllama(loadedChatPsBody, tagsBody);
    const baseUrl = "http://localhost:11434";
    const cacheKey = "exclude-loaded-from-cached-list";
    expect((await discoverViaOllama(baseUrl, { key: cacheKey })).model).toBe(
      "vl-bu-30b-a3b-preview:Q4_K_M"
    );

    // Reuse the same key: exclude must walk the ranked list cached above.
    const outcome = await discoverViaOllama(baseUrl, {
      key: cacheKey,
      exclude: new Set(["vl-bu-30b-a3b-preview:Q4_K_M"]),
    });
    expect(outcome.model).not.toBeNull();
    expect(["gemma4:31b-cloud", "qwen3.5:0.8b-mlx", "vl-bu-30b-a3b-preview:Q4_K_M"]).toContain(
      outcome.model!
    );
    expect(outcome.model).not.toBe("vl-bu-30b-a3b-preview:Q4_K_M");
  });

  test("prefers the smallest chat model within the unloaded tier", async () => {
    mockOllama(emptyModelsBody, tagsBody);
    const outcome = await discoverViaOllama("http://localhost:11434", {
      key: "smallest-unloaded-chat",
    });
    expect(outcome.model).toBe("gemma4:31b-cloud");
  });

  test("reports a clear error when both Ollama endpoints are empty", async () => {
    mockOllama(emptyModelsBody, emptyModelsBody);
    const outcome = await discoverViaOllama("http://localhost:11434", {
      key: "genuinely-empty",
    });
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("no models on");
  });

  test("keeps the non-chat reason when every Ollama model is an embedder", async () => {
    mockOllama(embedderOnlyPsBody, embedderOnlyTagsBody);
    const outcome = await discoverViaOllama("http://localhost:11434", {
      key: "embedder-only-everywhere",
    });
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toMatch(/described as non-chat/);
  });

  test("prefers smaller loaded model from /api/ps", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "llama3-70b", size: 70_000_000_000, capabilities: ["completion"] },
              { name: "llama3-3b", size: 3_000_000_000, capabilities: ["completion"] },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaOllama("http://localhost:11434", { key: "ps-test" });
    expect(outcome.model).toBe("llama3-3b");
  });

  test("falls back to /api/tags when no models loaded", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "qwen-7b", size: 7_000_000_000, capabilities: ["completion"] },
              { name: "tinyllama-1b", size: 1_000_000_000, capabilities: ["completion"] },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaOllama("http://localhost:11434", { key: "tags-fallback" });
    expect(outcome.model).toBe("tinyllama-1b");
  });

  test("returns null + reason when both endpoints empty", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
    ) as unknown as typeof fetch;
    const outcome = await discoverViaOllama("http://localhost:11434", { key: "empty" });
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("no models");
  });

  test("skips embedding models even when they're smallest by size", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "vectorizer-small",
                size: 45_000_000,
                capabilities: ["embedding"],
              }, // smallest BUT embedding; its name gives no hint
              { name: "retrieval-base", size: 274_000_000, capabilities: ["embedding"] },
              { name: "llama-3.2-3b", size: 3_000_000_000, capabilities: ["completion"] },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaOllama("http://localhost:11434", {
      key: "embed-skip",
    });
    expect(outcome.model).toBe("llama-3.2-3b");
  });
});

describe("discoverViaLMStudio", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    _clearProbeDiscoveryCache();
    // The classifier memoizes its catalog projection across files; drop it so this fixture is read.
    _clearChatCapabilityIndex();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    _clearProbeDiscoveryCache();
    _clearChatCapabilityIndex();
  });

  test("prefers loaded models over not-loaded ones", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "big-model-loaded", state: "loaded", type: "llm" },
              { id: "tiny-mini-not-loaded", state: "not-loaded", type: "llm" },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-loaded-first" }
    );
    // Loaded wins even though the not-loaded one has "mini" in name.
    expect(outcome.model).toBe("big-model-loaded");
  });

  test("falls back to not-loaded models when nothing loaded", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "qwen-large", state: "not-loaded", type: "llm" },
              { id: "llama-mini", state: "not-loaded", type: "llm" },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-only-cold" }
    );
    // Among not-loaded, the small-name heuristic picks llama-mini.
    expect(outcome.model).toBe("llama-mini");
  });

  test("filters out embedding-type entries", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "all-minilm:latest", state: "loaded", type: "embeddings" },
              { id: "llama-3-loaded", state: "loaded", type: "llm" },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-embed-skip" }
    );
    expect(outcome.model).toBe("llama-3-loaded");
  });

  test("falls back to /v1/models when /api/v0/models returns 404", async () => {
    globalThis.fetch = mock(async (input: any) => {
      const url = String(input);
      if (url.endsWith("/api/v0/models")) {
        return new Response("", { status: 404 });
      }
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });
      }
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-old-version" }
    );
    expect(outcome.model).toBe("gpt-4o-mini");
  });

  test("returns null + reason when nothing chat-capable", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "nomic-embed-text", state: "loaded", type: "embeddings" }],
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    const outcome = await discoverViaLMStudio(
      "http://localhost:1234",
      {},
      { key: "lmstudio-only-embed" }
    );
    expect(outcome.model).toBeNull();
    expect(outcome.reason).toContain("chat-capable");
  });
});
