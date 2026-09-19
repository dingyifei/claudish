import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SlimModelEntry, readAllModelsCache } from "./all-models-cache.js";
import {
  _resetCatalogClient,
  catalogWarmDisabledFor,
  getCatalogEntries,
  refreshCatalog,
  resolveTargetForCatalog,
} from "./catalog-client.js";
import { parseModelSpec } from "./model-parser.js";

const realFetch = globalThis.fetch;
let previousDisableCatalogWarm: string | undefined;
let previousCatalogUrl: string | undefined;
let previousPlansUrl: string | undefined;
const tempDirs: string[] = [];

function tempCachePath(prefix = "claudish-catalog-client-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, "all-models.json");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  previousDisableCatalogWarm = process.env.CLAUDISH_DISABLE_CATALOG_WARM;
  previousCatalogUrl = process.env.CLAUDISH_CATALOG_URL;
  previousPlansUrl = process.env.CLAUDISH_PLANS_URL;
  _resetCatalogClient();
});

afterEach(() => {
  restoreEnv("CLAUDISH_DISABLE_CATALOG_WARM", previousDisableCatalogWarm);
  restoreEnv("CLAUDISH_CATALOG_URL", previousCatalogUrl);
  restoreEnv("CLAUDISH_PLANS_URL", previousPlansUrl);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  globalThis.fetch = realFetch;
  _resetCatalogClient();
});

describe("refreshCatalog catalog-warm kill switch", () => {
  // This regression is a race: a sibling test's sticky empty-catalog override
  // could let the process exit before a live fetch reached the developer's
  // cache. The fetch assertion proves the kill switch returns before that path.
  test("returns disabled before network or disk side effects", async () => {
    process.env.CLAUDISH_DISABLE_CATALOG_WARM = "1";
    const fetchStub = mock(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                modelId: "offline-test-model",
                aliases: [],
                sources: { test: { externalId: "test/offline-test-model" } },
              },
            ],
            plans: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const outcome = await refreshCatalog(100, { cachePath: tempCachePath() });

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "disabled" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('recognizes only "1" as disabled', () => {
    expect(catalogWarmDisabledFor("1")).toBe(true);
  });

  // Pass negative values as arguments: this avoids writing a process-global
  // another file's detached warmCatalog() may read, and a required parameter is
  // the only way to express "explicitly unset" because a default fires on undefined.
  for (const [label, switchValue] of [
    ['"true"', "true"],
    ['"0"', "0"],
    ['""', ""],
    ["undefined", undefined],
  ] as const) {
    test(`does not disable catalog warm for ${label}`, () => {
      expect(catalogWarmDisabledFor(switchValue)).toBe(false);
    });
  }
});

const catalogEntry = (modelId: string): SlimModelEntry => ({
  modelId,
  aliases: [],
  sources: { "openrouter-api": { externalId: `future-labs/${modelId}` } },
  reasoningStatus: "unknown",
});

describe("refreshCatalog revision-pinned pagination", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let cachePath = "";
  let handleRequest: (request: Request) => Response | Promise<Response>;

  beforeEach(() => {
    cachePath = tempCachePath();
    handleRequest = () => new Response(null, { status: 500 });
    server = Bun.serve({
      port: 0,
      fetch: (request) => handleRequest(request),
    });
    const origin = `http://127.0.0.1:${server.port}`;

    // ORDER IS LOAD-BEARING. The URL redirect goes up BEFORE the warm gate comes
    // down, and never the other way round.
    //
    // `proxy-server.ts` fires an un-awaited `warmCatalog()` on every
    // `createProxyServer`, so a detached refresh can reach `catalogWarmDisabled()`
    // at any instant while this suite runs. Clearing the gate first leaves a
    // window in which such a refresh is enabled AND still pointed at the live
    // catalog — it then fetches over the network and writes the developer's real
    // `~/.claudish/all-models.json`.
    //
    // That is not hypothetical. It is the leak `catalog-client.ts` documents
    // having measured on 2026-09-15, and this file reproduced it on 2026-09-17:
    // `guard-real-config` reported "REAL MODEL CATALOG CACHE MUTATED — changed
    // lastUpdated" on one `test:safe` run and not the next, because whether the
    // detached warm lands inside the window depends on file ordering.
    //
    // With this order, anything that slips through hits the local server instead,
    // and the guard's remaining job is a backstop rather than a cleanup.
    process.env.CLAUDISH_CATALOG_URL = `${origin}/queryModels?status=active&catalog=slim&limit=7`;
    process.env.CLAUDISH_PLANS_URL = `${origin}/queryPlans`;
    delete process.env.CLAUDISH_DISABLE_CATALOG_WARM;
  });

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  function json(data: unknown, revision?: string, status = 200): Response {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (revision) headers.set("X-Catalog-Revision", revision);
    return new Response(JSON.stringify(data), { status, headers });
  }

  async function seedPreviousGeneration(): Promise<{
    bytes: string;
    memory: SlimModelEntry[];
  }> {
    const previousEntry = catalogEntry("orion-7.3-future");
    handleRequest = (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/queryModels") {
        return json(
          { models: [previousEntry], total: 1, offset: 0, limit: 1000, hasMore: false },
          "revision-previous"
        );
      }
      if (url.pathname === "/queryPlans") {
        return json({ plans: [{ id: "previous-plan" }] }, "revision-previous");
      }
      return new Response(null, { status: 404 });
    };

    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "refreshed",
      modelCount: 1,
      catalogRevision: "revision-previous",
      pages: 1,
    });
    const memory = getCatalogEntries();
    expect(memory).toEqual([previousEntry]);
    return { bytes: readFileSync(cachePath, "utf-8"), memory: memory! };
  }

  function expectPreviousGenerationPreserved(previous: {
    bytes: string;
    memory: SlimModelEntry[];
  }): void {
    expect(readFileSync(cachePath, "utf-8")).toBe(previous.bytes);
    expect(getCatalogEntries()).toBe(previous.memory);
  }

  test("follows every page, advances by returned rows, and pins pages and plans", async () => {
    const requests: Array<{
      path: string;
      offset: string | null;
      limit: string | null;
      revision: string | null;
      revisionHeader: string | null;
    }> = [];
    const first = [catalogEntry("orion-7.4-future"), catalogEntry("qwen4.2-nebula")];
    const second = [catalogEntry("claude-opus-6-future")];

    handleRequest = (request) => {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        offset: url.searchParams.get("offset"),
        limit: url.searchParams.get("limit"),
        revision: url.searchParams.get("revision"),
        revisionHeader: request.headers.get("revision"),
      });
      if (url.pathname === "/queryPlans") {
        return json({ plans: [{ id: "future-plan" }] }, "revision-a");
      }
      if (url.searchParams.get("offset") === "0") {
        return json(
          { models: first, total: 3, offset: 0, limit: 1000, hasMore: true },
          "revision-a"
        );
      }
      return json(
        { models: second, total: 3, offset: 2, limit: 1000, hasMore: false },
        "revision-a"
      );
    };

    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "refreshed",
      modelCount: 3,
      catalogRevision: "revision-a",
      pages: 2,
    });

    expect(requests).toEqual([
      {
        path: "/queryModels",
        offset: "0",
        limit: "1000",
        revision: null,
        revisionHeader: null,
      },
      {
        path: "/queryModels",
        offset: "2",
        limit: "1000",
        revision: "revision-a",
        revisionHeader: null,
      },
      {
        path: "/queryPlans",
        offset: null,
        limit: null,
        revision: "revision-a",
        revisionHeader: null,
      },
    ]);
    const cache = readAllModelsCache(cachePath);
    expect(cache?.entries).toEqual([...first, ...second]);
    expect(cache?.plans).toEqual([{ id: "future-plan" }]);
    expect(cache?.catalogRevision).toBe("revision-a");
  });

  test("accepts the currently deployed one-page response when hasMore is omitted", async () => {
    const onlyPage = [catalogEntry("orion-8.0-future")];
    let modelRequests = 0;
    handleRequest = (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/queryPlans") return json({ plans: [] }, "revision-current");
      modelRequests++;
      return json({ models: onlyPage, total: 1, offset: 0, limit: 1000 }, "revision-current");
    };

    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "refreshed",
      modelCount: 1,
      catalogRevision: "revision-current",
      pages: 1,
    });
    expect(modelRequests).toBe(1);
    expect(readAllModelsCache(cachePath)?.entries).toEqual(onlyPage);
    expect(readAllModelsCache(cachePath)?.catalogRevision).toBe("revision-current");
  });

  test("rejects a later page from another revision and preserves both caches byte-for-byte", async () => {
    const previous = await seedPreviousGeneration();
    handleRequest = (request) => {
      const url = new URL(request.url);
      if (url.searchParams.get("offset") === "0") {
        return json({ models: [catalogEntry("new-page-one")], hasMore: true }, "revision-new");
      }
      expect(url.searchParams.get("revision")).toBe("revision-new");
      return json({ models: [catalogEntry("new-page-two")], hasMore: false }, "revision-other");
    };

    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "fetch_failed",
      reason: "revision_mismatch",
    });
    expectPreviousGenerationPreserved(previous);
  });

  test("rejects a later HTTP failure as incomplete and preserves both caches byte-for-byte", async () => {
    const previous = await seedPreviousGeneration();
    handleRequest = (request) => {
      const url = new URL(request.url);
      if (url.searchParams.get("offset") === "0") {
        return json({ models: [catalogEntry("new-page-one")], hasMore: true }, "revision-new");
      }
      expect(url.searchParams.get("revision")).toBe("revision-new");
      return new Response("later page failed", { status: 500 });
    };

    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "fetch_failed",
      reason: "incomplete",
    });
    expectPreviousGenerationPreserved(previous);
  });

  test("rejects a later network failure as incomplete and preserves both caches byte-for-byte", async () => {
    const previous = await seedPreviousGeneration();
    const stopped = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
    const stoppedPort = stopped.port;
    stopped.stop(true);

    handleRequest = (request) => {
      const url = new URL(request.url);
      if (url.searchParams.get("offset") !== "0") {
        return new Response("unexpected second request to live server", { status: 500 });
      }
      process.env.CLAUDISH_CATALOG_URL = `http://127.0.0.1:${stoppedPort}/queryModels?status=active&catalog=slim`;
      return json({ models: [catalogEntry("new-page-one")], hasMore: true }, "revision-new");
    };

    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "fetch_failed",
      reason: "incomplete",
    });
    expectPreviousGenerationPreserved(previous);
  });

  test("rejects hasMore with an empty page instead of looping or committing a prefix", async () => {
    const previous = await seedPreviousGeneration();
    let pageRequests = 0;
    handleRequest = (request) => {
      const url = new URL(request.url);
      pageRequests++;
      if (url.searchParams.get("offset") === "0") {
        return json({ models: [catalogEntry("new-page-one")], hasMore: true }, "revision-new");
      }
      return json({ models: [], hasMore: true }, "revision-new");
    };

    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "fetch_failed",
      reason: "incomplete",
    });
    expect(pageRequests).toBe(2);
    expectPreviousGenerationPreserved(previous);
  });
});

describe("resolveTargetForCatalog", () => {
  test("rewrites a changed explicit MiniMax spec and returns its resolution", () => {
    const resolution = {
      resolvedId: "MiniMax-M2.5",
      wasResolved: true,
      sourceLabel: "minimax catalog",
    };

    const result = resolveTargetForCatalog(
      "mm@minimax-m2.5",
      true,
      "minimax-m2.5",
      "minimax",
      () => resolution
    );

    expect(result).toEqual({
      target: "minimax@MiniMax-M2.5",
      resolution,
    });
    expect(parseModelSpec(result.target).isExplicitProvider).toBe(true);
  });

  test("preserves a bare MiniMax name and never resolves it", () => {
    let resolveCalls = 0;
    const result = resolveTargetForCatalog("minimax-m2.5", false, "minimax-m2.5", "minimax", () => {
      resolveCalls += 1;
      return {
        resolvedId: "MiniMax-M2.5",
        wasResolved: true,
        sourceLabel: "minimax catalog",
      };
    });

    // Rewriting this bare name would yield `minimax@MiniMax-M2.5`, which
    // parseModelSpec reads as an explicit provider and makes proxy-server skip
    // the routing chain. MiniMax is the only measured family whose wire id
    // differs from the typed name, so unaffected passthrough models cannot catch
    // this regression.
    expect(result).toEqual({ target: "minimax-m2.5", resolution: null });
    expect(parseModelSpec(result.target).isExplicitProvider).toBe(false);
    expect(resolveCalls).toBe(0);
  });

  test("keeps an unchanged explicit target but returns its resolution", () => {
    const resolution = {
      resolvedId: "glm-5.2",
      wasResolved: false,
      sourceLabel: "passthrough",
    };

    const result = resolveTargetForCatalog("glm@glm-5.2", true, "glm-5.2", "glm", () => resolution);

    expect(result).toEqual({ target: "glm@glm-5.2", resolution });
  });

  for (const [model, provider] of [
    ["glm-5.2", "glm"],
    ["kimi-k2.7", "kimi"],
  ] as const) {
    test(`leaves unaffected ${model} explicit and bare forms unchanged`, () => {
      const passthrough = () => ({
        resolvedId: model,
        wasResolved: false,
        sourceLabel: "passthrough",
      });
      const explicitTarget = `${provider}@${model}`;

      const explicit = resolveTargetForCatalog(explicitTarget, true, model, provider, passthrough);
      const bare = resolveTargetForCatalog(model, false, model, provider, passthrough);

      expect(explicit.target).toBe(explicitTarget);
      expect(explicit.resolution).not.toBeNull();
      expect(bare).toEqual({ target: model, resolution: null });
    });
  }
});
