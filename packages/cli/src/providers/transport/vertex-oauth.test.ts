/**
 * Regression pin for Step 5d — Vertex AI OAuth delegation.
 *
 * VertexProviderTransport.refreshAuth() used to call getVertexAuthManager()
 * .getAccessToken() directly and getHeaders() built Authorization: Bearer
 * <accessToken> inline. Step 5 delegates the normal-path header construction to
 * credentials.getRequestAuth("vertex"), while KEEPING forceRefreshAuth()'s
 * cache-busting 401-retry semantics (the credential's getRequestAuth does not
 * express a force-refresh, so the transport still busts the shared manager cache
 * directly, then re-delegates).
 *
 * This test pins:
 *   - getHeaders() after refreshAuth() → Authorization: Bearer <delegated token>
 *   - delegation targets the "vertex" catalog name
 *   - forceRefreshAuth() busts the manager cache (refreshToken called) AND
 *     re-delegates → getHeaders() returns the refreshed token
 *   - getEndpoint() / transformPayload() / getRequestInit() are unchanged
 *
 * Hermetic: a fake `vertex` credential registered on the REAL authority delegates
 * to `getRequestAuthMock` (the real one is re-registered in afterAll), and the
 * vertex-auth manager is mocked (so refreshToken is observable and no gcloud/ADC
 * is touched). Never `mock.module()` the authority: Bun keeps that replacement
 * for the rest of the process, and every later file that imports `credentials`
 * got a fake with no `register`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { credentials } from "../../auth/credentials/authority.js";
import type { CredentialProvider } from "../../auth/credentials/types.js";
import type { VertexConfig } from "../../auth/vertex-auth.js";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";

const {
  buildVertexOAuthEndpoint: actualBuildVertexOAuthEndpoint,
  vertexApiHost: actualVertexApiHost,
} = await import("../../auth/vertex-auth.js");

let currentToken = "vertex-token-A";
const refreshTokenMock = mock(async () => {
  currentToken = "vertex-token-B"; // force-refresh swaps the token
});
const getAccessTokenMock = mock(async () => currentToken);

let getRequestAuthMock = mock(async (_name: string, _ctx: any) => ({
  headers: { Authorization: `Bearer ${currentToken}` },
}));

// Registered under "vertex" ONLY. The authority consumes the name in its registry
// lookup, so the fake passes that name on itself; the mock is reached only when
// the transport asked for "vertex", which the delegation assertions pin together.
const fakeVertexCredential: CredentialProvider = {
  catalogName: "vertex",
  isAvailable: async () => true,
  describeReadiness: async () => ({ readiness: "present" }),
  getRequestAuth: (ctx) => getRequestAuthMock("vertex", ctx),
};

let realVertexCredential: CredentialProvider | undefined;

beforeAll(() => {
  realVertexCredential = credentials.get("vertex");
  if (!realVertexCredential) {
    throw new Error("the authority has no vertex credential to restore after this file");
  }
  credentials.register(fakeVertexCredential, ["vertex"]);
  credentials.invalidate("vertex");
});

afterAll(() => {
  // Put the real credential back so no later file in the Bun run signs with the fake.
  if (realVertexCredential) credentials.register(realVertexCredential, ["vertex"]);
  credentials.invalidate("vertex");
});

mock.module("../../auth/vertex-auth.js", () => ({
  getVertexAuthManager: () => ({
    getAccessToken: getAccessTokenMock,
    refreshToken: refreshTokenMock,
  }),
  buildVertexOAuthEndpoint: (_config: any, publisher: string, model: string, _streaming: boolean) =>
    `https://vertex.example/${publisher}/${model}:streamGenerateContent`,
}));

const { VertexProviderTransport, parseVertexModel } = await import("./vertex-oauth.js");

const config = { project: "p", location: "us-central1" } as unknown as VertexConfig;

beforeEach(() => {
  currentToken = "vertex-token-A";
  refreshTokenMock.mockClear();
  getAccessTokenMock.mockClear();
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => ({
    headers: { Authorization: `Bearer ${currentToken}` },
  }));
});

afterEach(() => {
  mock.restore();
});

describe("vertexApiHost", () => {
  test("uses the bare API host for global", () => {
    const host = actualVertexApiHost("global");

    expect(host).toBe("aiplatform.googleapis.com");
    expect(host).not.toBe("global-aiplatform.googleapis.com");
  });

  test("uses the REP host for eu", () => {
    const host = actualVertexApiHost("eu");

    expect(host).toBe("aiplatform.eu.rep.googleapis.com");
    expect(host).not.toBe("eu-aiplatform.googleapis.com");
  });

  test("uses the regional host for us-central1", () => {
    expect(actualVertexApiHost("us-central1")).toBe("us-central1-aiplatform.googleapis.com");
  });

  test("deliberately keeps us on the regional host", () => {
    // Deliberate per the vertexApiHost docblock: "us" is not a REP alias.
    expect(actualVertexApiHost("us")).toBe("us-aiplatform.googleapis.com");
  });

  test("uses the regional template for an arbitrary region", () => {
    expect(actualVertexApiHost("europe-west4")).toBe("europe-west4-aiplatform.googleapis.com");
  });
});

describe("buildVertexOAuthEndpoint", () => {
  const projectId = "test-project";

  test("builds a regional streaming Google endpoint", () => {
    const config: VertexConfig = { projectId, location: "us-central1" };

    expect(actualBuildVertexOAuthEndpoint(config, "google", "gemini-2.5-flash", true)).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
  });

  test("builds an eu REP streaming Google endpoint while retaining locations/eu", () => {
    const config: VertexConfig = { projectId, location: "eu" };

    expect(actualBuildVertexOAuthEndpoint(config, "google", "gemini-2.5-flash", true)).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/test-project/locations/eu/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
  });

  test("builds a non-streaming global Google endpoint", () => {
    const config: VertexConfig = { projectId, location: "global" };

    expect(actualBuildVertexOAuthEndpoint(config, "google", "gemini-2.5-flash", false)).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent"
    );
  });

  test("builds an eu REP streaming Mistral endpoint", () => {
    const config: VertexConfig = { projectId, location: "eu" };

    expect(actualBuildVertexOAuthEndpoint(config, "mistralai", "mistral-large-2411", true)).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/test-project/locations/eu/publishers/mistralai/models/mistral-large-2411:streamRawPredict"
    );
  });

  test("keeps other partners on the fixed global OpenAI-compatible endpoint", () => {
    const config: VertexConfig = { projectId, location: "europe-west4" };

    expect(actualBuildVertexOAuthEndpoint(config, "anthropic", "claude-sonnet-4", true)).toBe(
      "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/endpoints/openapi/chat/completions"
    );
  });
});

describe("VertexProviderTransport — delegated auth", () => {
  test("refreshAuth() → getHeaders() returns the delegated Bearer token", async () => {
    const t = new VertexProviderTransport(config, parseVertexModel("gemini-2.5-flash"));
    await t.refreshAuth();
    const headers = await t.getHeaders();
    expect(headers.Authorization).toBe("Bearer vertex-token-A");

    expect(getRequestAuthMock).toHaveBeenCalledTimes(1);
    expect(getRequestAuthMock.mock.calls[0][0]).toBe("vertex");
  });

  test("forceRefreshAuth() busts the manager cache and re-delegates the fresh token", async () => {
    const t = new VertexProviderTransport(config, parseVertexModel("gemini-2.5-flash"));
    await t.refreshAuth();
    expect((await t.getHeaders()).Authorization).toBe("Bearer vertex-token-A");

    await t.forceRefreshAuth();
    // Cache was busted via the shared manager (401-retry semantics preserved).
    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    // Re-delegated artifact carries the refreshed token.
    expect((await t.getHeaders()).Authorization).toBe("Bearer vertex-token-B");
  });

  test("refreshAuth() preserves the credential failure as `cause`", async () => {
    // `classifyConnectionError` finds a network failure by walking `.code` and
    // then the `.cause` chain to depth 8. This catch used to rethrow a bare
    // `new Error("Vertex AI auth failed: …")`, discarding both — so a DNS or
    // refused-connection failure while minting the token classified as `null`,
    // ComposedHandler's refreshAuth catch answered 401, and `isRetryableError`
    // read that as retryable and walked the user down the fallback chain during
    // a network outage. One extra argument is the whole fix; this pins it.
    const underlying = Object.assign(new Error("Unable to connect."), {
      code: "ConnectionRefused",
    });
    getRequestAuthMock = mock(async () => {
      throw underlying;
    });

    const t = new VertexProviderTransport(config, parseVertexModel("gemini-2.5-flash"));

    let thrown: unknown;
    try {
      await t.refreshAuth();
    } catch (e) {
      thrown = e;
    }

    expect((thrown as Error).message).toContain("Vertex AI auth failed");
    expect((thrown as Error).cause).toBe(underlying);
    expect(classifyConnectionError(thrown)).toEqual({
      kind: "refused",
      code: "ConnectionRefused",
    });
  });

  test("getEndpoint() / getRequestInit() unchanged; anthropic transformPayload unchanged", () => {
    const t = new VertexProviderTransport(config, parseVertexModel("anthropic/claude-3-5-sonnet"));
    expect(t.getEndpoint()).toBe(
      "https://vertex.example/anthropic/claude-3-5-sonnet:streamGenerateContent"
    );
    const init = t.getRequestInit();
    expect(init.signal).toBeDefined();

    const payload: any = { model: "claude-3-5-sonnet", messages: [] };
    const out = t.transformPayload(payload);
    expect(out.anthropic_version).toBe("vertex-2023-10-16");
    expect(out.model).toBeUndefined();
  });
});
