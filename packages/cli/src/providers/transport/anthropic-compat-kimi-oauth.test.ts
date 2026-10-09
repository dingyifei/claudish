/**
 * Regression pin for Step 5a — Kimi Coding OAuth delegation.
 *
 * The `kimi-coding` branch of AnthropicProviderTransport.getHeaders() used to
 * read ~/.claudish/kimi-oauth.json directly and mint OAuth headers inline. Step 5
 * delegates that to the credential authority's getRequestAuth("kimi-coding").
 *
 * This test pins the EXACT header shape the transport produces for a kimi-coding
 * provider when an OAuth token is available, so the delegated path is byte-for-byte
 * equivalent to the old inline path:
 *   - anthropic-version: 2023-06-01
 *   - Authorization: Bearer <token>
 *   - the 6 X-Msh-* platform headers
 *   - NO x-api-key
 *
 * It also pins that NON-OAuth providers (MiniMax / Z.AI) are unaffected — they keep
 * their plain x-api-key / Bearer + anthropic-version + provider.headers path.
 *
 * Hermetic strategy: fake credentials registered on the REAL authority (the single
 * dispatch point the transport now calls) delegate to `getRequestAuthMock`, so no
 * real OAuth file / SDK is touched. The real credentials are re-registered in
 * afterAll. Never `mock.module()` the authority: Bun keeps that replacement for
 * the rest of the process, and every later file that imports `credentials` got a
 * fake with no `register`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { credentials } from "../../auth/credentials/authority.js";
import type { CredentialProvider } from "../../auth/credentials/types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { AnthropicProviderTransport } from "./anthropic-compat.js";

const FAKE_TOKEN = "kimi-oauth-token-xyz";

// The platform headers the real KimiOAuth.getPlatformHeaders() returns. The
// credential impl merges these into the kimi-coding request auth.
const PLATFORM_HEADERS: Record<string, string> = {
  "X-Msh-Platform": "claudish",
  "X-Msh-Version": "9.9.9",
  "X-Msh-Device-Name": "test-host",
  "X-Msh-Device-Model": "darwin-arm64",
  "X-Msh-Os-Version": "25.0.0",
  "X-Msh-Device-Id": "device-abc",
};

// What credentials.getRequestAuth("kimi-coding") returns when OAuth is present.
// This mirrors KimiOAuthHalf.getRequestAuth() exactly.
const KIMI_OAUTH_AUTH = {
  headers: {
    "anthropic-version": "2023-06-01",
    Authorization: `Bearer ${FAKE_TOKEN}`,
    ...PLATFORM_HEADERS,
  },
};

// ── Fake the authority's credentials (the new delegation target) ──────────────
let getRequestAuthMock = mock(async (_name: string, _ctx: any) => KIMI_OAUTH_AUTH as any);

// Every name this file's transports could sign under. "kimi-coding" is the
// delegation under test. "minimax" and "z-ai" are faked too so the "no authority
// call" assertions can still fail: without a fake, a call under either name
// would reach the real api-key provider and never touch the mock.
const FAKED_NAMES = ["kimi-coding", "minimax", "z-ai"] as const;

/** Answers under `name` only, and passes that name on (the authority consumes it). */
function fakeCredential(name: string): CredentialProvider {
  return {
    catalogName: name,
    isAvailable: async () => true,
    describeReadiness: async () => ({ readiness: "present" }),
    getRequestAuth: (ctx) => getRequestAuthMock(name, ctx),
  };
}

const realCredentials = new Map<string, CredentialProvider>();

beforeAll(() => {
  for (const name of FAKED_NAMES) {
    const real = credentials.get(name);
    if (!real) {
      throw new Error(`the authority has no ${name} credential to restore after this file`);
    }
    realCredentials.set(name, real);
    credentials.register(fakeCredential(name), [name]);
    credentials.invalidate(name);
  }
});

afterAll(() => {
  // Put the real credentials back so no later file in the Bun run signs with a fake.
  for (const [name, real] of realCredentials) {
    credentials.register(real, [name]);
    credentials.invalidate(name);
  }
  realCredentials.clear();
});

beforeEach(() => {
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => KIMI_OAUTH_AUTH as any);
});

afterEach(() => {
  mock.restore();
});

describe("AnthropicProviderTransport — kimi-coding OAuth delegation", () => {
  const kimiCoding: RemoteProvider = {
    name: "kimi-coding",
    baseUrl: "https://api.moonshot.cn",
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "KIMI_CODING_API_KEY",
    prefixes: ["mmc@"],
    authScheme: "x-api-key",
  };

  test("OAuth present: anthropic-version + Bearer + 6 platform headers, NO x-api-key", async () => {
    const transport = new AnthropicProviderTransport(kimiCoding, "stale-api-key");
    const headers = await transport.getHeaders();

    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(headers["x-api-key"]).toBeUndefined();

    expect(headers["X-Msh-Platform"]).toBe("claudish");
    expect(headers["X-Msh-Version"]).toBe("9.9.9");
    expect(headers["X-Msh-Device-Name"]).toBe("test-host");
    expect(headers["X-Msh-Device-Model"]).toBe("darwin-arm64");
    expect(headers["X-Msh-Os-Version"]).toBe("25.0.0");
    expect(headers["X-Msh-Device-Id"]).toBe("device-abc");
  });

  test("OAuth path failure falls back to the plain x-api-key header", async () => {
    getRequestAuthMock = mock(async () => {
      throw new Error("OAuth unavailable");
    });
    const transport = new AnthropicProviderTransport(kimiCoding, "fallback-api-key");
    const headers = await transport.getHeaders();

    // Falls back to the plain api-key path: x-api-key set, no Bearer.
    expect(headers["x-api-key"]).toBe("fallback-api-key");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("AnthropicProviderTransport — non-kimi providers are NOT routed through the authority", () => {
  test("minimax (bearer): plain Bearer + anthropic-version, no authority call", async () => {
    const minimax: RemoteProvider = {
      name: "minimax",
      baseUrl: "https://api.minimax.io",
      apiPath: "/anthropic/v1/messages",
      apiKeyEnvVar: "MINIMAX_API_KEY",
      prefixes: ["mm@"],
      authScheme: "bearer",
    };
    const transport = new AnthropicProviderTransport(minimax, "mm-key");
    const headers = await transport.getHeaders();

    expect(headers.Authorization).toBe("Bearer mm-key");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(getRequestAuthMock).toHaveBeenCalledTimes(0);
  });

  test("z-ai (x-api-key default) with provider.headers: unchanged, no authority call", async () => {
    const zai: RemoteProvider = {
      name: "z-ai",
      baseUrl: "https://api.z.ai",
      apiPath: "/anthropic/v1/messages",
      apiKeyEnvVar: "ZAI_API_KEY",
      prefixes: ["zai@"],
      headers: { "X-Custom": "z-value" },
    };
    const transport = new AnthropicProviderTransport(zai, "zai-key");
    const headers = await transport.getHeaders();

    expect(headers["x-api-key"]).toBe("zai-key");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["X-Custom"]).toBe("z-value");
    expect(getRequestAuthMock).toHaveBeenCalledTimes(0);
  });
});
