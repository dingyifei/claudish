import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { credentials } from "../../auth/credentials/authority.js";
import { resetVertexProjectDiscovery } from "../../auth/vertex-auth.js";
import { _clearVertexDiscoveryCache, discoverVertexProbeModel } from "./vertex-discovery.js";
import { parseVertexModel } from "./vertex-oauth.js";

const originalFetch = globalThis.fetch;
const originalGetRequestAuth = credentials.getRequestAuth;
const originalProject = process.env.VERTEX_PROJECT;
const originalLocation = process.env.VERTEX_LOCATION;

const listedModels = [
  {
    name: "publishers/google/models/gemini-3.8-flash",
    launchStage: "GA",
    publisherModelTemplate:
      "projects/{project}/locations/{location}/publishers/google/models/gemini-3.8-flash",
  },
  {
    name: "publishers/google/models/gemini-2.5-flash",
    launchStage: "GA",
    publisherModelTemplate:
      "projects/{project}/locations/{location}/publishers/google/models/gemini-2.5-flash",
  },
];

function installHttpFixture(statuses: Record<string, number>): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);

    if (url.endsWith("/v1beta1/publishers/google/models")) {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("x-goog-user-project")).toBe("vertex-test-project");
      return Response.json({ publisherModels: listedModels });
    }

    const match = url.match(/\/models\/([^/:]+):countTokens$/);
    if (!match) throw new Error(`unexpected Vertex discovery request: ${url}`);
    expect(init?.method).toBe("POST");
    const status = statuses[match[1]] ?? 200;
    return new Response(status === 200 ? "{}" : `fixture HTTP ${status}`, { status });
  }) as typeof fetch;
  return requests;
}

describe.serial("Vertex discovery confirmation", () => {
  beforeEach(() => {
    process.env.VERTEX_PROJECT = "vertex-test-project";
    process.env.VERTEX_LOCATION = "us-central1";
    resetVertexProjectDiscovery();
    _clearVertexDiscoveryCache();
    credentials.getRequestAuth = async () => ({
      headers: { Authorization: "Bearer offline-vertex-test-token" },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    credentials.getRequestAuth = originalGetRequestAuth;
    if (originalProject === undefined) delete process.env.VERTEX_PROJECT;
    else process.env.VERTEX_PROJECT = originalProject;
    if (originalLocation === undefined) delete process.env.VERTEX_LOCATION;
    else process.env.VERTEX_LOCATION = originalLocation;
    resetVertexProjectDiscovery();
    _clearVertexDiscoveryCache();
  });

  test("a 404 removes a listed model and the returned id round-trips", async () => {
    const requests = installHttpFixture({ "gemini-3.8-flash": 404 });

    const result = await discoverVertexProbeModel();
    expect(result).toEqual({ model: "gemini-2.5-flash" });
    expect(parseVertexModel(result.model!)).toEqual({
      publisher: "google",
      model: "gemini-2.5-flash",
    });
    expect(requests.filter((url) => url.endsWith(":countTokens"))).toHaveLength(2);
  });

  for (const status of [429, 503]) {
    test(`HTTP ${status} keeps the candidate because the confirmation is inconclusive`, async () => {
      installHttpFixture({ "gemini-3.8-flash": status });

      expect(await discoverVertexProbeModel()).toEqual({ model: "gemini-3.8-flash" });
    });
  }

  test("exclude returns the next confirmed candidate without re-listing", async () => {
    const requests = installHttpFixture({});

    expect(await discoverVertexProbeModel()).toEqual({ model: "gemini-3.8-flash" });
    expect(await discoverVertexProbeModel(new Set(["gemini-3.8-flash"]))).toEqual({
      model: "gemini-2.5-flash",
    });
    expect(
      requests.filter((url) => url.endsWith("/v1beta1/publishers/google/models"))
    ).toHaveLength(1);
  });
});
