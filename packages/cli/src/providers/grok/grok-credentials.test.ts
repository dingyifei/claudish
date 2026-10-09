import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROK_PUBLIC_CLIENT_ID } from "../../auth/grok-oauth.js";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import {
  DEFAULT_GROK_PROXY_URL,
  FALLBACK_GROK_CLIENT_VERSION,
  GROK_PROXY_URL_ENV,
  type GrokCredential,
  forceRefreshGrokAccessToken,
  grokAuthHeaders,
  hasGrokCredentials,
  isGrokCredentialExpired,
  readGrokClientVersion,
  readGrokCredential,
  readGrokProxyUrl,
  resolveGrokAccessToken,
  resolveGrokClientId,
  resolveGrokClientVersion,
  setGrokHomeForTesting,
} from "./grok-credentials.js";

const NOW = Date.parse("2026-08-18T00:00:00.000Z");
const OIDC_SCOPE = "https://auth.x.ai::TEST-CLIENT-ID";
const LEGACY_SCOPE = "https://accounts.x.ai/sign-in";

let grokHome: string;
let savedProxyUrl: string | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  grokHome = mkdtempSync(join(tmpdir(), "claudish-grok-credentials-"));
  savedProxyUrl = process.env[GROK_PROXY_URL_ENV];
  delete process.env[GROK_PROXY_URL_ENV];
  setGrokHomeForTesting(grokHome);
});

afterEach(() => {
  setGrokHomeForTesting(null);
  globalThis.fetch = realFetch;
  if (savedProxyUrl === undefined) delete process.env[GROK_PROXY_URL_ENV];
  else process.env[GROK_PROXY_URL_ENV] = savedProxyUrl;
  rmSync(grokHome, { recursive: true, force: true });
});

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(grokHome, name), `${JSON.stringify(value, null, 2)}\n`);
}

function writeAuth(value: unknown): void {
  writeJson("auth.json", value);
}

function expiredEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "tok-old",
    refresh_token: "ref-old",
    expires_at: "2000-01-01T00:00:00.000Z",
    auth_mode: "oidc",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "TEST-CLIENT-ID",
    ...overrides,
  };
}

async function rejectedError(promise: Promise<unknown>): Promise<Error & { terminal?: boolean }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error & { terminal?: boolean };
  }
  throw new Error("Expected promise to reject");
}

describe("readGrokCredential", () => {
  test("a missing auth file is the normal no-credential state", () => {
    // Most users do not have the Grok CLI installed, so absence must never crash startup.
    expect(() => readGrokCredential()).not.toThrow();
    expect(readGrokCredential()).toBeUndefined();
  });

  test("malformed JSON degrades to no credential", () => {
    writeFileSync(join(grokHome, "auth.json"), "{ definitely-not-json");

    // A partially written CLI-owned file must not turn provider discovery into an exception.
    expect(() => readGrokCredential()).not.toThrow();
    expect(readGrokCredential()).toBeUndefined();
  });

  test("prefers an oidc entry over a legacy-scope entry", () => {
    writeAuth({
      [LEGACY_SCOPE]: { key: "tok-legacy" },
      [OIDC_SCOPE]: {
        key: "tok-oidc",
        auth_mode: "oidc",
        oidc_client_id: "TEST-CLIENT-ID",
      },
    });

    // Current OIDC credentials must win even when an older login entry remains on disk.
    expect(readGrokCredential()).toMatchObject({
      scope: OIDC_SCOPE,
      key: "tok-oidc",
      authMode: "oidc",
    });
  });

  test("uses the legacy scope when no oidc entry exists", () => {
    writeAuth({
      "https://fixture.invalid/unmarked": { key: "tok-unmarked" },
      [LEGACY_SCOPE]: { key: "tok-legacy" },
    });

    // This preserves compatibility with credentials emitted by older Grok installers.
    expect(readGrokCredential()).toMatchObject({
      scope: LEGACY_SCOPE,
      key: "tok-legacy",
    });
  });

  test("uses a lone valid entry even when it has neither known marker", () => {
    const scope = "https://fixture.invalid/only-entry";
    writeAuth({ [scope]: { key: "tok-only" } });

    expect(readGrokCredential()).toMatchObject({ scope, key: "tok-only" });
  });

  test("skips entries whose key is missing or empty", () => {
    const validScope = "https://fixture.invalid/valid";
    writeAuth({
      [OIDC_SCOPE]: { auth_mode: "oidc" },
      [LEGACY_SCOPE]: { key: "   " },
      [validScope]: { key: "tok-valid" },
    });

    // Metadata-only entries cannot authorize a request and must not mask a usable fallback.
    expect(readGrokCredential()).toMatchObject({ scope: validScope, key: "tok-valid" });
  });

  test.each([
    ["missing", { auth_mode: "oidc" }],
    ["empty", { key: "" }],
  ])("returns undefined when its single entry has a %s key", (_case, entry) => {
    writeAuth({ [OIDC_SCOPE]: entry });

    expect(readGrokCredential()).toBeUndefined();
  });

  test("round-trips the literal scope key instead of hardcoding a client id", () => {
    writeAuth({
      [OIDC_SCOPE]: {
        key: "tok-scope",
        auth_mode: "oidc",
        oidc_client_id: "TEST-CLIENT-ID",
      },
    });

    // The client id embedded in this scope can rotate, so the top-level key is authoritative.
    expect(readGrokCredential()?.scope).toBe(OIDC_SCOPE);
  });
});

describe("hasGrokCredentials", () => {
  test("is true with only claudish's own OAuth store", () => {
    writeJson("claudish-grok-oauth.json", { access_token: "tok-own" });

    // This is the no-Grok-CLI-required claim: the owned OAuth store alone makes Grok ready.
    expect(hasGrokCredentials()).toBe(true);
  });

  test("is true with only the Grok CLI credential", () => {
    writeAuth({ [OIDC_SCOPE]: { key: "tok-cli" } });

    // Existing `grok login` users remain supported without claudish's OAuth store.
    expect(hasGrokCredentials()).toBe(true);
  });
});

describe("resolveGrokClientId", () => {
  test("prefers the client id recorded by the local Grok CLI", () => {
    const clientId = "TEST-ROTATED-CLIENT-ID";
    writeAuth({
      [`https://auth.x.ai::${clientId}`]: {
        key: "tok-cli",
        auth_mode: "oidc",
        oidc_client_id: clientId,
      },
    });

    // The local value absorbs an xAI client-id rotation without requiring a claudish release.
    expect(resolveGrokClientId()).toBe(clientId);
  });

  test("uses the published client id when no local credential exists", () => {
    expect(resolveGrokClientId()).toBe(GROK_PUBLIC_CLIENT_ID);
  });
});

describe("isGrokCredentialExpired", () => {
  function credential(expiresAt?: string): GrokCredential {
    return { scope: OIDC_SCOPE, key: "tok-expiry", expiresAt };
  }

  test("is false well before expires_at", () => {
    const expiresAt = new Date(NOW + 10 * 60 * 1000).toISOString();
    expect(isGrokCredentialExpired(credential(expiresAt), NOW)).toBe(false);
  });

  test("is true after expires_at", () => {
    const expiresAt = new Date(NOW - 1).toISOString();
    expect(isGrokCredentialExpired(credential(expiresAt), NOW)).toBe(true);
  });

  test("is true inside the five-minute pre-expiry skew window", () => {
    const expiresAt = new Date(NOW + 4 * 60 * 1000).toISOString();

    // Refreshing before the deadline prevents an in-flight request from racing token expiry.
    expect(isGrokCredentialExpired(credential(expiresAt), NOW)).toBe(true);
  });

  test("cannot prove expiry when expires_at is missing or unparseable", () => {
    // Needless refresh can rotate an otherwise working token, so uncertainty stays live.
    expect(isGrokCredentialExpired(credential(), NOW)).toBe(false);
    expect(isGrokCredentialExpired(credential("not-a-date"), NOW)).toBe(false);
  });
});

describe("readGrokClientVersion", () => {
  test("reads the installed version instead of pinning a literal", () => {
    writeJson("version.json", { version: "9.9.9" });
    writeJson("models_cache.json", { grok_version: "8.8.8" });

    // The proxy enforces a moving minimum, so the user's installed value must win.
    expect(readGrokClientVersion()).toBe("9.9.9");
  });

  test("falls back to models_cache.json when version.json is absent", () => {
    writeJson("models_cache.json", { grok_version: "8.8.8" });
    expect(readGrokClientVersion()).toBe("8.8.8");
  });

  test("falls back to models_cache.json when version.json is garbage", () => {
    writeFileSync(join(grokHome, "version.json"), "not-json");
    writeJson("models_cache.json", { grok_version: "8.8.8" });
    expect(readGrokClientVersion()).toBe("8.8.8");
  });

  test("uses the last-resort version when neither local source is readable", () => {
    writeFileSync(join(grokHome, "version.json"), "not-json");
    writeFileSync(join(grokHome, "models_cache.json"), "also-not-json");

    expect(readGrokClientVersion()).toBe(FALLBACK_GROK_CLIENT_VERSION);
  });
});

describe("resolveGrokClientVersion", () => {
  test("uses the local install without making a network request", async () => {
    writeJson("version.json", { version: "9.9.9" });
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run when a local version exists");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolveGrokClientVersion()).resolves.toBe("9.9.9");
    // An installed CLI is authoritative and version resolution must stay offline.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("fetches the stable channel pointer when no local install exists", async () => {
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("9.9.10\n", { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolveGrokClientVersion()).resolves.toBe("9.9.10");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://x.ai/cli/stable");
  });

  test("rejects an invalid channel body and falls back to the floor", async () => {
    const fetchMock = mock(
      async () => new Response("<!doctype html><title>fixture error</title>", { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolveGrokClientVersion()).resolves.toBe(FALLBACK_GROK_CLIENT_VERSION);
    // The fetched value is signed into a request header, so HTML must never pass through.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("grokAuthHeaders", () => {
  test("emits exactly the three headers required by the Grok proxy", () => {
    // Omitting client identity makes the proxy reject every request as an outdated CLI.
    expect(grokAuthHeaders("tok-headers", "9.9.9")).toEqual({
      Authorization: "Bearer tok-headers",
      "x-grok-client-version": "9.9.9",
      "x-grok-client-identifier": "grok-shell",
    });
  });
});

describe("readGrokProxyUrl", () => {
  test("defaults to the Grok CLI chat proxy", () => {
    expect(readGrokProxyUrl()).toBe(DEFAULT_GROK_PROXY_URL);
  });

  test("honours GROK_PROXY_URL and strips trailing slashes", () => {
    process.env[GROK_PROXY_URL_ENV] = "https://proxy.fixture.invalid/custom///";
    expect(readGrokProxyUrl()).toBe("https://proxy.fixture.invalid/custom");
  });
});

describe("resolveGrokAccessToken", () => {
  test("returns a live token without making a refresh request", async () => {
    writeAuth({
      [OIDC_SCOPE]: {
        ...expiredEntry(),
        key: "tok-live",
        expires_at: "2999-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run for a live token");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolveGrokAccessToken()).resolves.toBe("tok-live");
    // A refresh can rotate credentials, so live tokens must stay completely off the network.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("a missing credential rejects with a terminal error", async () => {
    const error = await rejectedError(resolveGrokAccessToken());

    // Login cannot self-heal through retries; terminal errors render inline instead.
    expect(error.terminal).toBe(true);
    expect(error.message).toContain("grok login");
  });

  test("refreshes an expired token and writes rotated values back", async () => {
    const unrelatedScope = {
      key: "tok-other",
      refresh_token: "ref-other",
      custom_flag: "preserve-exactly",
    };
    writeAuth({
      [OIDC_SCOPE]: {
        ...expiredEntry(),
        email: "person@example.invalid",
        team_id: "team-placeholder",
      },
      "https://auth.x.ai::OTHER-CLIENT-ID": unrelatedScope,
    });
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "tok-new",
            refresh_token: "ref-new",
            expires_in: 3600,
          }),
          { status: 200 }
        )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const beforeRefresh = Date.now();

    await expect(resolveGrokAccessToken()).resolves.toBe("tok-new");

    const afterRefresh = Date.now();
    const written = JSON.parse(readFileSync(join(grokHome, "auth.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(written[OIDC_SCOPE].key).toBe("tok-new");
    expect(written[OIDC_SCOPE].refresh_token).toBe("ref-new");
    const expiresAt = Date.parse(String(written[OIDC_SCOPE].expires_at));
    expect(expiresAt).toBeGreaterThanOrEqual(beforeRefresh + 3600 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(afterRefresh + 3600 * 1000);

    // auth.json belongs to the Grok CLI, so refresh must not damage its other metadata.
    expect(written[OIDC_SCOPE].email).toBe("person@example.invalid");
    expect(written[OIDC_SCOPE].team_id).toBe("team-placeholder");
    expect(JSON.stringify(written["https://auth.x.ai::OTHER-CLIENT-ID"])).toBe(
      JSON.stringify(unrelatedScope)
    );
  });

  test("marks an invalid_grant refresh response as terminal", async () => {
    writeAuth({ [OIDC_SCOPE]: expiredEntry() });
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Invalid placeholder refresh token",
          }),
          { status: 400 }
        )
    ) as unknown as typeof fetch;

    const error = await rejectedError(resolveGrokAccessToken());

    // Only a fresh Grok login can replace a dead refresh token, so retries would be wasteful.
    expect(error.terminal).toBe(true);
    expect(error.message).toContain("Invalid placeholder refresh token");
    expect(error.message).toContain("grok login");
  });

  test("leaves a refresh network failure non-terminal", async () => {
    writeAuth({ [OIDC_SCOPE]: expiredEntry() });
    globalThis.fetch = mock(async () => {
      throw new Error("fixture network offline");
    }) as unknown as typeof fetch;

    const error = await rejectedError(resolveGrokAccessToken());

    // A network blip can self-heal, so it must reach the normal provider retry path.
    expect(error).not.toHaveProperty("terminal");
    expect(error.message).toContain("fixture network offline");
  });

  test.each([
    ["refresh_token", { refresh_token: undefined }],
    ["oidc_client_id", { oidc_client_id: undefined }],
  ])("missing %s on an expired credential is terminal", async (_field, overrides) => {
    writeAuth({ [OIDC_SCOPE]: expiredEntry(overrides) });
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run without complete refresh credentials");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const error = await rejectedError(resolveGrokAccessToken());

    // Neither missing field can be recovered without another interactive login.
    expect(error.terminal).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("shares one refresh across concurrent callers", async () => {
    writeAuth({ [OIDC_SCOPE]: expiredEntry() });
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "tok-single-flight",
            refresh_token: "ref-single-flight",
            expires_in: 3600,
          }),
          { status: 200 }
        )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = resolveGrokAccessToken();
    const second = resolveGrokAccessToken();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "tok-single-flight",
      "tok-single-flight",
    ]);
    // A second concurrent refresh could submit a token invalidated by the first rotation.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("sends a public-client form body with no client secret", async () => {
    writeAuth({
      [OIDC_SCOPE]: expiredEntry({
        refresh_token: "ref-form",
        oidc_client_id: "TEST-FORM-CLIENT-ID",
        oidc_issuer: "https://issuer.fixture.invalid/",
      }),
    });
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ access_token: "tok-form", expires_in: 3600 }), {
          status: 200,
        })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolveGrokAccessToken()).resolves.toBe("tok-form");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://issuer.fixture.invalid/oauth2/token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "ref-form",
      client_id: "TEST-FORM-CLIENT-ID",
    });
    // auth.x.ai registers the Grok CLI as a public client; adding a secret would be incorrect.
    expect([...form.keys()].some((key) => key.toLowerCase().includes("secret"))).toBe(false);
  });
});

describe("forceRefreshGrokAccessToken", () => {
  test("refreshes a live token and persists the rotated credential", async () => {
    writeAuth({
      [OIDC_SCOPE]: {
        ...expiredEntry(),
        key: "tok-live",
        refresh_token: "ref-live",
        expires_at: "2999-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "tok-forced",
            refresh_token: "ref-forced",
            expires_in: 3600,
          }),
          { status: 200 }
        )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolveGrokAccessToken()).resolves.toBe("tok-live");
    // Normal resolution must trust a live expiry value and avoid needless token rotation.
    expect(fetchMock).toHaveBeenCalledTimes(0);

    await expect(forceRefreshGrokAccessToken()).resolves.toBe("tok-forced");
    // A 401 is the server overruling advisory expiry, so forced refresh must still use the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const written = JSON.parse(readFileSync(join(grokHome, "auth.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    // Persisting both rotated values keeps the Grok CLI's shared credential usable after refresh.
    expect(written[OIDC_SCOPE]).toMatchObject({
      key: "tok-forced",
      refresh_token: "ref-forced",
    });
  });

  test("a missing credential rejects with a terminal error", async () => {
    const error = await rejectedError(forceRefreshGrokAccessToken());

    // A transport retry cannot manufacture a missing login, so it must stop immediately.
    expect(error.terminal).toBe(true);
  });

  test("shares the expiry path's single-flight refresh", async () => {
    writeAuth({ [OIDC_SCOPE]: expiredEntry() });
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "tok-shared-flight",
            refresh_token: "ref-shared-flight",
            expires_in: 3600,
          }),
          { status: 200 }
        )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const expiryRefresh = resolveGrokAccessToken();
    const forcedRefresh = forceRefreshGrokAccessToken();

    await expect(Promise.all([expiryRefresh, forcedRefresh])).resolves.toEqual([
      "tok-shared-flight",
      "tok-shared-flight",
    ]);
    // Two refreshes could race a rotating refresh token and invalidate the second request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries after a failed refresh clears the single-flight latch", async () => {
    writeAuth({ [OIDC_SCOPE]: expiredEntry() });
    const failedFetch = mock(async () => {
      throw new Error("fixture first refresh failed");
    });
    globalThis.fetch = failedFetch as unknown as typeof fetch;

    await expect(forceRefreshGrokAccessToken()).rejects.toThrow("fixture first refresh failed");

    const successfulFetch = mock(
      async () =>
        new Response(JSON.stringify({ access_token: "tok-retried", expires_in: 3600 }), {
          status: 200,
        })
    );
    globalThis.fetch = successfulFetch as unknown as typeof fetch;

    await expect(forceRefreshGrokAccessToken()).resolves.toBe("tok-retried");
    // A rejected promise must leave the latch reusable instead of poisoning every later attempt.
    expect(failedFetch).toHaveBeenCalledTimes(1);
    expect(successfulFetch).toHaveBeenCalledTimes(1);
  });
});

describe("a refused token exchange names the AUTH host, not the inference host", () => {
  test("the error carries claudishEndpoint = the token endpoint", async () => {
    // `getHeaders()` is a `gk@` request's FIRST network touch and it reaches
    // `auth.x.ai` — never `api.x.ai`. `ComposedHandler` falls back to the MODEL
    // endpoint when the error carries no `claudishEndpoint`, so without this
    // the recovery banner, the `[Recovery]` log and the episode key all named a
    // host that was never contacted, and told the user to check their network
    // for it. `local.ts` attaches the same property for the same reason.
    writeAuth({ [OIDC_SCOPE]: expiredEntry() });
    let connectFailure: unknown;
    try {
      await realFetch("http://127.0.0.1:1/refused-on-purpose");
    } catch (e) {
      connectFailure = e;
    }
    globalThis.fetch = mock(async () => {
      throw connectFailure;
    }) as unknown as typeof fetch;

    const error = await rejectedError(resolveGrokAccessToken());

    expect((error as { claudishEndpoint?: string }).claudishEndpoint).toBe(
      "https://auth.x.ai/oauth2/token"
    );
    // And the syscall evidence still rides in `cause`, so this remains a
    // CONNECTION failure rather than an auth one — a network fault during a
    // refresh must not walk the user down the fallback chain onto metered
    // billing.
    expect(classifyConnectionError(error)).toEqual({
      kind: "refused",
      code: "ConnectionRefused",
    });
  });
});
