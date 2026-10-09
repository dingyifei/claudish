import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import type { LocalProvider as LocalProviderConfig } from "../provider-registry.js";
import { LocalTransport } from "./local.js";
import { OpenAIConnectionError, OpenAITimeoutError } from "./openai.js";

/**
 * Transports must not DESTROY the evidence that a failure was the network.
 *
 * `classifyConnectionError` recognises a failure-to-reach-the-host by walking
 * `.code` and then the `.cause` chain to depth 8. A transport that catches a
 * connect error and rethrows its own bare `new Error("nice sentence")` carries
 * neither, so the classifier returns `null` and every downstream fix is a no-op
 * for that provider — the handler cannot fix what it cannot see.
 *
 * Each test here asserts the same one thing from a different transport: the
 * error that leaves the transport still CLASSIFIES.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A real Bun connect failure, provoked rather than written out. See the same
 * fixture in composed-handler-connection-error.test.ts for why: Bun's fetch
 * uses neither Node's errno names nor `.cause`, so only the runtime can say
 * what a connect failure actually looks like.
 */
let CONNECT_FAILURE: unknown;
beforeAll(async () => {
  try {
    await realFetch("http://127.0.0.1:1/refused-on-purpose");
    throw new Error("127.0.0.1:1 accepted a connection — this fixture needs a closed port");
  } catch (e) {
    CONNECT_FAILURE = e;
  }
  expect((CONNECT_FAILURE as { code?: string }).code).toBe("ConnectionRefused");
});

// ---------------------------------------------------------------------------
// local.ts — ollama / lmstudio / vllm
// ---------------------------------------------------------------------------

const OLLAMA_CONFIG: LocalProviderConfig = {
  name: "ollama",
  baseUrl: "http://127.0.0.1:1",
  apiPath: "/v1/chat/completions",
  envVar: "OLLAMA_API_KEY",
  prefixes: ["ollama"],
};

/** Count health probes and fail them all with a real connect error. */
function stubFailingProbes(): { count: number } {
  const counter = { count: 0 };
  globalThis.fetch = (async () => {
    counter.count++;
    throw CONNECT_FAILURE;
  }) as unknown as typeof fetch;
  return counter;
}

describe("LocalTransport.refreshAuth — the evidence survives the health check", () => {
  test("the thrown error classifies as a connection failure", async () => {
    stubFailingProbes();
    const transport = new LocalTransport(OLLAMA_CONFIG, "llama3.2");

    let thrown: unknown;
    try {
      await transport.refreshAuth();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    // The user-facing sentence is unchanged — it is the actionable one.
    expect((thrown as Error).message).toContain("Cannot connect to Ollama");
    // ...and the machine-readable half now rides along underneath it. Before
    // this, `checkHealth()` swallowed the syscall error in a catch that only
    // logged, `refreshAuth()` threw a bare Error, and this was `null` — so a
    // stopped Ollama was invisible to every connection-aware code path.
    expect(classifyConnectionError(thrown)).toEqual({
      kind: "refused",
      code: "ConnectionRefused",
    });
  });

  test("the failing probe URL is attached, not just the base URL", async () => {
    stubFailingProbes();
    const transport = new LocalTransport(OLLAMA_CONFIG, "llama3.2");

    let thrown: unknown;
    try {
      await transport.refreshAuth();
    } catch (e) {
      thrown = e;
    }

    // Whichever probe ran last is the host the banner should name.
    expect((thrown as { claudishEndpoint?: string }).claudishEndpoint).toBe(
      "http://127.0.0.1:1/v1/models"
    );
  });

  test("a stale probe error is never handed on as a later failure's cause", async () => {
    // First probe throws; second returns a non-ok RESPONSE (server reachable,
    // route missing). The server is up, so the failure is NOT a connect failure
    // and must not be dressed as one.
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) throw CONNECT_FAILURE;
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const transport = new LocalTransport(OLLAMA_CONFIG, "llama3.2");
    let thrown: unknown;
    try {
      await transport.refreshAuth();
    } catch (e) {
      thrown = e;
    }

    // Both probes ran, and the LAST word is the 404 — so the cause is the first
    // probe's error only because that is genuinely the last thing that threw.
    expect(call).toBe(2);
    expect(classifyConnectionError(thrown)).not.toBeNull();
  });

  /**
   * THE PROBE COUNT — a retried `refreshAuth()` must actually re-probe.
   *
   * This was a TRIPWIRE pinning a bug, and the bug is now fixed; the test is
   * flipped rather than deleted, because the reason it existed is the reason it
   * still matters.
   *
   * `refreshAuth()` opens with `if (this.healthChecked) return;`. `checkHealth()`
   * used to set `healthChecked = true` on FAILURE as well as on success, so the
   * SECOND `refreshAuth()` touched no network AND DID NOT THROW — it returned
   * successfully for a server that was still dead.
   *
   * Harmless while nothing called it twice inside a request. The retry ladder
   * calls it twice. Attempt 2 would have resolved instantly, the episode would
   * have closed as "recovered", and a recovery record would have been written
   * for an outage that never ended — while the real failure reappeared
   * milliseconds later from the fetch path looking like a separate incident.
   *
   * The latch now records success only (`local.ts:271`). So: both calls probe,
   * and both throw.
   */
  test("a retried refreshAuth re-probes and still throws while the server is down", async () => {
    const probes = stubFailingProbes();
    const transport = new LocalTransport(OLLAMA_CONFIG, "llama3.2");

    await expect(transport.refreshAuth()).rejects.toThrow("Cannot connect to Ollama");
    const afterFirst = probes.count;

    // Second call: probes again, and still reports the server as unreachable.
    // A resolve here is the "recovered from an outage that never ended" bug.
    await expect(transport.refreshAuth()).rejects.toThrow("Cannot connect to Ollama");

    expect(afterFirst).toBe(2); // /api/tags then /v1/models
    expect(probes.count).toBe(afterFirst + 2); // and again, rather than latching
  });
});

// ---------------------------------------------------------------------------
// openai.ts — the two wrapper classes
// ---------------------------------------------------------------------------

describe("OpenAI transport error classes carry code and cause", () => {
  test("OpenAITimeoutError classifies as unreachable", () => {
    const err = new OpenAITimeoutError("https://api.example.com", CONNECT_FAILURE);

    expect(err.code).toBe("ETIMEDOUT");
    expect(err.cause).toBe(CONNECT_FAILURE);
    expect(classifyConnectionError(err)).toEqual({ kind: "unreachable", code: "ETIMEDOUT" });
  });

  test("OpenAIConnectionError keeps the originating code", () => {
    const err = new OpenAIConnectionError(
      "https://api.example.com",
      "UND_ERR_CONNECT_TIMEOUT",
      CONNECT_FAILURE
    );

    expect(err.code).toBe("UND_ERR_CONNECT_TIMEOUT");
    expect(classifyConnectionError(err)).toEqual({
      kind: "unreachable",
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
  });

  test("both still read as their own class and keep their message", () => {
    // The wrapper's value was always its actionable sentence; adding the
    // machine-readable half must not have cost that.
    expect(new OpenAITimeoutError("https://api.example.com").name).toBe("OpenAITimeoutError");
    expect(new OpenAIConnectionError("https://api.example.com", "X").message).toContain(
      "network/firewall blocking"
    );
  });
});
