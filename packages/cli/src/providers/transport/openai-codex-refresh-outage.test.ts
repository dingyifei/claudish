/**
 * Behaviour tests C1–C4 — a Codex token refresh that cannot reach the network
 * must not bill metered.
 *
 * Spec: ai-docs/sessions/dev-feature-network-recovery-20260910-110514-0ad0a5a0/overlay/codex-spec.md
 * Written black-box from that spec and its contract (codex-contract.md,
 * auth/credentials/types.ts). The transport's source was not an input.
 *
 * `openai-codex` signs with a ChatGPT subscription (OAuth) when it can and
 * otherwise falls back to a METERED api key at api.openai.com. The two ways an
 * OAuth refresh can fail must end differently:
 *
 *  - REJECTED by the token server (revoked / expired refresh token): falling
 *    back to the api key is intended — `refreshAuth()` resolves (C2).
 *  - UNREACHABLE (network outage): the subscription still exists, it is only out
 *    of reach. Falling back would bill a subscriber per token for an outage, so
 *    `refreshAuth()` must REJECT with an error `classifyConnectionError`
 *    recognises, so the handler can hold and retry the request (C1).
 *
 * Test plan (REQ id → tests):
 *   REQ-1 / C1  unreachable → rejects, classifiable, never resolves   C1-bare, C1-wrapped
 *   REQ-2 / C2  rejected    → resolves, endpoint is NOT chatgpt.com   C2 × 2 rejection shapes
 *   REQ-3 / C3  oauth       → resolves, endpoint is the artifact's     C3
 *   REQ-4 / C4  fixture guard: the connection failure classifies,      C4 × 4
 *               the rejections do not
 *
 * Fixture rules (from the contract, all load-bearing):
 *  - NO `mock.module()`. The fake credential is installed with
 *    `credentials.register(fake, ["openai-codex"])`, and afterEach re-registers
 *    the REAL `makeCodexCredential()` so no later test or file inherits the fake.
 *  - The connection failure is a REAL failed `fetch` to a loopback port proven
 *    free (a server was bound to it, then stopped, and the fetch is refused).
 *    Never a hand-made `{ code: "ECONNREFUSED" }` — a hand-made error proves only
 *    that the classifier recognises the hand-made shape.
 *  - refreshAuth() writes the process-wide signed-arm billing record; afterEach
 *    clears it (as the sibling openai-codex-*.test.ts files do) so this file
 *    never decides billing for the next file in the Bun run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { credentials } from "../../auth/credentials/authority.js";
import { clearSignedArm } from "../../auth/credentials/billing-probe.js";
import { makeCodexCredential } from "../../auth/credentials/codex-credential.js";
import type {
  CredentialProvider,
  RequestAuth,
  RequestAuthContext,
} from "../../auth/credentials/types.js";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { OpenAICodexTransport } from "./openai-codex.js";

const PROVIDER: RemoteProvider = {
  name: "openai-codex",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/responses",
  apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
  prefixes: ["cx@", "codex@"],
};
const MODEL = "gpt-5.1-codex";
const API_KEY = "sk-codex-key";
const SUBSCRIPTION_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/** The spec's example of a genuinely REJECTED refresh (C2). */
function invalidGrantRejection(): Error {
  return new Error("OAuth credentials invalid. Please run `claudish login codex` again.", {
    cause: new Error("Token refresh failed: 400 - invalid_grant"),
  });
}

/** A second non-network rejection: the token server's answer, unwrapped. */
function bareServerRejection(): Error {
  return new Error("Token refresh failed: 400 - invalid_grant");
}

/**
 * A REAL connection failure: bind a server to an ephemeral loopback port, stop
 * it, then POST to that port. Nothing listens, so the fetch is refused. Returns
 * the value `fetch` threw, untouched.
 */
async function realConnectionFailure(): Promise<unknown> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = server.port;
  await server.stop(true);
  try {
    await fetch(`http://127.0.0.1:${port}/oauth/token`, { method: "POST" });
  } catch (err) {
    return err;
  }
  throw new Error(
    `fixture broken: port ${port} was expected to be free, but a fetch to it succeeded`
  );
}

/** The real failure wrapped the way a refresh routine would wrap it. */
function wrapped(real: unknown): Error {
  return new Error("Token refresh failed: could not reach auth.openai.com", { cause: real });
}

/**
 * A fake `openai-codex` credential. It is available and present; its
 * `getRequestAuth` does whatever the test says. `consulted` counts calls — used
 * ONLY as a precondition guard (the spec's "when getRequestAuth throws …" is not
 * met if it is never asked), never as the behaviour under test.
 */
function installFakeCodexCredential(
  getRequestAuth: (ctx: RequestAuthContext) => Promise<RequestAuth>
): { consulted: () => number } {
  let calls = 0;
  const fake: CredentialProvider = {
    catalogName: "openai-codex",
    isAvailable: async () => true,
    describeReadiness: async () => ({ readiness: "present" }),
    getRequestAuth: async (ctx) => {
      calls += 1;
      return getRequestAuth(ctx);
    },
  };
  credentials.register(fake, ["openai-codex"]);
  credentials.invalidate("openai-codex");
  return { consulted: () => calls };
}

type Settled = { settled: "resolved" } | { settled: "rejected"; reason: unknown };

/** Let a promise settle either way, so the test can assert WHICH way. */
function settle(p: Promise<unknown>): Promise<Settled> {
  return p.then(
    () => ({ settled: "resolved" as const }),
    (reason: unknown) => ({ settled: "rejected" as const, reason })
  );
}

function newTransport(): OpenAICodexTransport {
  return new OpenAICodexTransport(PROVIDER, MODEL, API_KEY);
}

afterEach(() => {
  credentials.register(makeCodexCredential(), ["openai-codex"]);
  credentials.invalidate("openai-codex");
  clearSignedArm("openai-codex");
});

describe("C1 (REQ-1) — token host unreachable: refreshAuth rejects with a classifiable connection error", () => {
  test("C1-bare: rejects, and the rejection classifies non-null, when getRequestAuth throws the real fetch failure as-is", async () => {
    const real = await realConnectionFailure();
    const fake = installFakeCodexCredential(async () => {
      throw real;
    });
    const transport = newTransport();

    const outcome = await settle(transport.refreshAuth());

    expect(fake.consulted()).toBeGreaterThan(0);
    // Resolving here means the request proceeds on the metered api-key path.
    expect(outcome.settled).toBe("rejected");
    const reason = outcome.settled === "rejected" ? outcome.reason : undefined;
    expect(classifyConnectionError(reason)).not.toBeNull();
  });

  test("C1-wrapped: rejects, and the rejection classifies non-null, when getRequestAuth throws the real fetch failure as an Error cause", async () => {
    const real = await realConnectionFailure();
    const fake = installFakeCodexCredential(async () => {
      throw wrapped(real);
    });
    const transport = newTransport();

    const outcome = await settle(transport.refreshAuth());

    expect(fake.consulted()).toBeGreaterThan(0);
    expect(outcome.settled).toBe("rejected");
    const reason = outcome.settled === "rejected" ? outcome.reason : undefined;
    expect(classifyConnectionError(reason)).not.toBeNull();
  });
});

describe("C2 (REQ-2) — refresh REJECTED by the server: refreshAuth resolves and falls back to the api-key endpoint", () => {
  test.each([
    ["the spec's invalid_grant rejection, wrapped", invalidGrantRejection],
    ["a bare 400 invalid_grant rejection", bareServerRejection],
  ])(
    "C2: resolves, and getEndpoint is the provider's api-key base rather than chatgpt.com, for %s",
    async (_label, makeRejection) => {
      const fake = installFakeCodexCredential(async () => {
        throw makeRejection();
      });
      const transport = newTransport();

      const outcome = await settle(transport.refreshAuth());
      const endpoint = transport.getEndpoint(MODEL);

      expect(fake.consulted()).toBeGreaterThan(0);
      expect(outcome).toEqual({ settled: "resolved" });
      expect(endpoint).not.toBe(SUBSCRIPTION_ENDPOINT);
      expect(endpoint).not.toContain("chatgpt.com");
      expect(endpoint).toStartWith(PROVIDER.baseUrl);
    }
  );
});

describe("C3 (REQ-3) — OAuth artifact: refreshAuth resolves and the request goes to the subscription endpoint", () => {
  test("C3: resolves, and getEndpoint returns the artifact's chatgpt.com endpoint, when getRequestAuth returns an oauth artifact", async () => {
    installFakeCodexCredential(async () => ({
      arm: "oauth",
      headers: { Authorization: "Bearer fake-codex-oauth-access-token" },
      endpoint: SUBSCRIPTION_ENDPOINT,
    }));
    const transport = newTransport();

    const outcome = await settle(transport.refreshAuth());

    expect(outcome).toEqual({ settled: "resolved" });
    expect(transport.getEndpoint(MODEL)).toBe(SUBSCRIPTION_ENDPOINT);
  });
});

describe("C4 (REQ-4) — the fixtures prove something: the classifier separates the two kinds of throw", () => {
  test("C4: the real fetch failure is refused (the port was free) and classifies non-null", async () => {
    const real = await realConnectionFailure();

    expect(real).toBeInstanceOf(Error);
    // Refused = nothing was listening, which is the proof the port was free.
    expect((real as { code?: unknown }).code).toBe("ConnectionRefused");
    const classified = classifyConnectionError(real);
    expect(classified).not.toBeNull();
    expect(classified).toHaveProperty("kind");
  });

  test("C4: the real fetch failure wrapped as an Error cause classifies non-null", async () => {
    const real = await realConnectionFailure();

    expect(classifyConnectionError(wrapped(real))).not.toBeNull();
  });

  test("C4: the spec's invalid_grant rejection classifies null", () => {
    expect(classifyConnectionError(invalidGrantRejection())).toBeNull();
  });

  test("C4: the bare 400 invalid_grant rejection classifies null", () => {
    expect(classifyConnectionError(bareServerRejection())).toBeNull();
  });
});
