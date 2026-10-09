import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _resetAntigravityServedModelsCache,
  buildAntigravityUserAgent,
  getServedAntigravityModels,
  retrieveUserQuota,
} from "./antigravity-user.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  _resetAntigravityServedModelsCache();
});

afterEach(() => {
  _resetAntigravityServedModelsCache();
  globalThis.fetch = realFetch;
});

describe("retrieveUserQuota", () => {
  test("sends the Antigravity request identity", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ buckets: [] })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(retrieveUserQuota("access-token", "project-id")).resolves.toEqual({
      buckets: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const userAgent = new Headers(init?.headers).get("User-Agent");

    // The UA selects the backend tier: Code Assist silently restores the retired free-tier list.
    expect(userAgent).toBe(buildAntigravityUserAgent());
    expect(userAgent).not.toContain("gemini-code-assist");
  });
});

describe("getServedAntigravityModels", () => {
  test("surfaces backend metadata without fabricating missing context windows", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        models: {
          "claude-sonnet-4-6": {
            maxTokens: 250_000,
            maxOutputTokens: 64_000,
            displayName: "Claude Sonnet 4.6",
          },
          "gemini-3.1-flash-image": {
            maxOutputTokens: 32_768,
            displayName: "Gemini 3.1 Flash Image",
          },
          "zero-window": { maxTokens: 0 },
          "string-window": { maxTokens: "1048576" },
        },
        defaultAgentModelId: "claude-sonnet-4-6",
      })
    ) as unknown as typeof fetch;

    const result = await getServedAntigravityModels("placeholder-token", "placeholder-project");

    // The pre-existing contract for the dynamic models catalog and the backend default must survive metadata enrichment.
    expect(result.servedIds).toEqual([
      "claude-sonnet-4-6",
      "gemini-3.1-flash-image",
      "zero-window",
      "string-window",
    ]);
    expect(result.defaultId).toBe("claude-sonnet-4-6");
    expect(result.meta["claude-sonnet-4-6"]).toEqual({
      contextWindow: 250_000,
      maxOutputTokens: 64_000,
      displayName: "Claude Sonnet 4.6",
    });
    expect(result.meta["gemini-3.1-flash-image"]).toEqual({
      maxOutputTokens: 32_768,
      displayName: "Gemini 3.1 Flash Image",
    });

    // Missing windows must fall through to the catalog; a fabricated 0 would render as "N/A".
    expect("contextWindow" in result.meta["gemini-3.1-flash-image"]).toBe(false);
    expect("contextWindow" in result.meta["zero-window"]).toBe(false);
    expect("contextWindow" in result.meta["string-window"]).toBe(false);
  });

  test("returns an indexable empty meta object for an empty dynamic models catalog", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ models: {}, defaultAgentModelId: "unused-default" })
    ) as unknown as typeof fetch;

    // Callers can index meta without first guarding against an undefined field.
    await expect(
      getServedAntigravityModels("placeholder-token", "placeholder-project")
    ).resolves.toEqual({ servedIds: [], defaultId: null, meta: {} });
  });

  test("returns an indexable empty meta object when the endpoint fails", async () => {
    globalThis.fetch = mock(
      async () => new Response("unavailable", { status: 503 })
    ) as unknown as typeof fetch;

    // The fail-soft path must preserve the same complete result shape as the empty path.
    await expect(
      getServedAntigravityModels("placeholder-token", "placeholder-project")
    ).resolves.toEqual({ servedIds: [], defaultId: null, meta: {} });
  });
});
