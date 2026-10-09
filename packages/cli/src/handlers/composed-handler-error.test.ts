import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

/**
 * Integration tests for the error-surfacing WIRING in ComposedHandler.handle().
 *
 * The unit tests in shared/anthropic-error.test.ts prove the helper functions
 * (isTerminalError / buildSurfacedErrorMessage / extractProviderMessage) in
 * isolation. These tests prove the handler actually CALLS them on the upstream
 * error path: terminal errors must be remapped to a surfaced HTTP 400 (so Claude
 * Code stops its silent retry loop and shows the real reason), while transient
 * errors must keep their retryable status untouched (so legitimate retries still
 * happen). Without these, the user-visible behavior — the whole point of the
 * change — is unverified.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fake transport that returns a fixed upstream Response from a stubbed fetch. */
function makeTransport(): ProviderTransport {
  return {
    name: "sakana",
    displayName: "Sakana Fugu",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/v1/chat/completions",
    getHeaders: async () => ({}),
    // NOTE: deliberately NO forceRefreshAuth — keeps even a 401 on the generic
    // error branch (the path under test) instead of the OAuth-retry branch.
  } as unknown as ProviderTransport;
}

function makeTransportWithRefresh(
  onRefresh: () => void | Promise<void>,
  getHeaders: () => Promise<Record<string, string>> = async () => ({})
): ProviderTransport {
  return {
    ...makeTransport(),
    getHeaders,
    forceRefreshAuth: async () => {
      await onRefresh();
    },
  };
}

/** Stub global fetch to return one canned upstream error response. */
function stubUpstream(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  globalThis.fetch = (async () =>
    new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

interface StubbedUpstreamResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface SequencedFetchCall {
  input: string | URL | Request;
  init?: RequestInit;
}

/** Stub global fetch with one response per call and retain each request for assertions. */
function stubUpstreamSequence(...responses: StubbedUpstreamResponse[]): SequencedFetchCall[] {
  const calls: SequencedFetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = responses[calls.length];
    calls.push({ input, init });
    if (!response) {
      throw new Error(`Unexpected fetch call ${calls.length}`);
    }

    const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    return new Response(text, {
      status: response.status,
      headers: { "Content-Type": "application/json", ...response.headers },
    });
  }) as unknown as typeof fetch;
  return calls;
}

/** Stub global fetch to throw before any upstream response is received. */
function stubUpstreamThrow(error: unknown) {
  globalThis.fetch = (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

interface CapturedErrorBody {
  type?: string;
  error?: {
    type?: string;
    message?: string;
    upstream_status?: number;
  };
}

interface CapturedResponse {
  body?: CapturedErrorBody;
  status?: number;
}

/** Minimal Hono Context capturing what c.json() was called with. */
function makeContext(): { c: Context; captured: CapturedResponse } {
  const captured: CapturedResponse = {};
  const c = {
    // Opt out of the Tier-1 retry ladder. These tests assert how an error is
    // SURFACED, not whether it is retried, so they take the same escape hatch
    // `probe-live.ts:157` uses — the header read at `composed-handler.ts:441`.
    // Without it a provoked connect failure retries for the full deadline and
    // the assertions time out rather than failing.
    req: {
      header: (name?: string) =>
        name === undefined ? {} : name === "x-claudish-no-recovery" ? "1" : undefined,
    },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) => {
      captured.body = body as CapturedErrorBody;
      captured.status = status;
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    },
  } as unknown as Context;
  return { c, captured };
}

/** A minimal but valid Claude-format request payload. */
const PAYLOAD = {
  model: "fugu-ultra",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

const REGION_OPT_IN_URL = "https://opencode.ai/workspace/0123456789abcdef0123456789abcdef/go";

function makeHandler(): ComposedHandler {
  return new ComposedHandler(makeTransport(), "fugu-ultra", "fugu-ultra", 8080, {});
}

describe("ComposedHandler.handle — error surfacing wiring", () => {
  test("terminal billing 429 is remapped to a surfaced HTTP 400 (stops silent retry)", async () => {
    stubUpstream(429, {
      error: {
        message: "You exceeded your current quota, check your plan & billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    // Remapped away from the retryable 429 to a terminal 400.
    expect(captured.status).toBe(400);
    expect(captured.body?.type).toBe("error");
    expect(captured.body?.error?.type).toBe("invalid_request_error");
    // Rich, attributed, includes the real upstream message.
    expect(captured.body?.error?.message).toContain("Sakana Fugu error (HTTP 429)");
    expect(captured.body?.error?.message).toContain("exceeded your current quota");
  });

  test("a context overflow reaches the client LEADING with `prompt is too long`", async () => {
    // The whole point of item 8: providers state the overflow in their own
    // words, and no Anthropic client matches those words. Without the phrase the
    // client classifies this as a generic invalid request and never offers to
    // compact. Asserted through the handler, not the builder, because the
    // builder being right proves nothing if the wiring never asks for it.
    stubUpstream(400, {
      error: {
        message:
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("invalid_request_error");
    expect(captured.body?.error?.message?.startsWith("prompt is too long")).toBe(true);
    // The 400-remap contract: the real upstream status still rides along, and
    // the provider's own sentence is still there for a human to read.
    expect(captured.body?.error?.upstream_status).toBe(400);
    expect(captured.body?.error?.message).toContain("maximum context length is 128000 tokens");
  });

  test("a 413 overflow is remapped to 400 and keeps its upstream status", async () => {
    stubUpstream(413, {
      error: { message: "Payload too large: the prompt exceeds this model's context window" },
    });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.message?.startsWith("prompt is too long")).toBe(true);
    expect(captured.body?.error?.upstream_status).toBe(413);
  });

  test("a parameter rejection is NOT relabelled as an oversized prompt", async () => {
    // The ordering guard, end to end. `max_output_tokens` contains the word
    // "tokens"; adapters.md records the incident where that alone was enough to
    // report a 6.7 KB prompt against a 1.05M window as too large.
    stubUpstream(400, {
      error: {
        message: "Unknown parameter: 'max_output_tokens'.",
        type: "invalid_request_error",
        param: "max_output_tokens",
        code: "unknown_parameter",
      },
    });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.body?.error?.message ?? "").not.toContain("prompt is too long");
    // Unchanged from before item 8: not terminal, so the status passes through.
    expect(captured.status).toBe(400);
  });

  test("terminal auth 401 is surfaced as 400 (not silently retried)", async () => {
    stubUpstream(401, { error: { message: "invalid api key" } });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("invalid_request_error");
    expect(captured.body?.error?.message).toContain("Sakana Fugu error (HTTP 401)");
    expect(captured.body?.error?.message).toContain("invalid api key");
  });

  test("a model-unsupported 401 surfaces the model hint instead of an API-key hint", async () => {
    stubUpstream(401, {
      error: { message: "Model deepseek-v4-pro-0813 is not supported" },
    });
    const { c, captured } = makeContext();

    await makeHandler().handle(c, PAYLOAD);

    expect(captured.body?.error?.message).toContain("Model not supported by this provider");
    expect(captured.body?.error?.message).not.toContain("Check API key");
  });

  test("an invalid-key 401 surfaces the credential recovery hint", async () => {
    stubUpstream(401, { error: { message: "Invalid API key." } });
    const { c, captured } = makeContext();

    await makeHandler().handle(c, PAYLOAD);

    expect(captured.body?.error?.message).toContain("Check API key / OAuth credentials");
    expect(captured.body?.error?.message).not.toContain("Model not supported by this provider");
  });

  test("an actionable RegionError 403 surfaces its URL instead of an API-key hint", async () => {
    stubUpstream(403, {
      type: "error",
      error: {
        type: "RegionError",
        message: `The latest version of this model is only available hosted in China and requires explicit opt in: ${REGION_OPT_IN_URL}`,
      },
    });
    const { c, captured } = makeContext();

    await makeHandler().handle(c, PAYLOAD);

    expect(captured.body?.error?.message).not.toContain("Check API key");
    expect(captured.body?.error?.message).toContain(REGION_OPT_IN_URL);
  });

  test("transient 503 keeps its retryable status (Claude Code SHOULD retry)", async () => {
    stubUpstream(503, { error: { message: "temporary overload", type: "server_error" } });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    // NOT remapped — must stay 503 so the host retries the transient failure.
    expect(captured.status).toBe(503);
    expect(captured.body?.type).toBe("error");
    expect(captured.body?.error?.message).toContain("temporary overload");
  });

  test("plain (non-terminal) 429 rate-limit keeps its retryable status", async () => {
    stubUpstream(429, { error: { message: "rate limit exceeded, slow down" } });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(429);
    expect(captured.body?.error?.message).toContain("rate limit exceeded");
  });

  test("transient 500 whose prose contains 'not supported' is NOT mis-remapped to 400", async () => {
    // False-positive guard at the integration level: a transient 5xx body that
    // happens to contain a terminal-looking phrase must still retry.
    stubUpstream(503, {
      error: { message: "Retry-After header not supported by upstream gateway; overloaded" },
    });
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(503);
  });

  test("non-JSON upstream error body is still surfaced, not dropped", async () => {
    // 401 is terminal regardless of body shape → remapped to 400, raw text kept.
    stubUpstream(401, "Unauthorized");
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.message).toContain("Unauthorized");
  });

  // Keep connection failures at 400: both 400 and 503 stop claudish's fallback
  // chain, but Claude Code retries a 503 as overloaded_error and buries the real
  // reason behind "API error - Retrying - attempt N/10". A 400 is rendered
  // verbatim inline, while probe-live still classifies by the status-agnostic
  // connection_error type.
  test("a thrown DNS error is surfaced as a 400 connection_error", async () => {
    stubUpstreamThrow(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND host"), { code: "ENOTFOUND" }),
      })
    );
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.type).toBe("error");
    expect(captured.body?.error?.type).toBe("connection_error");
    expect(captured.body?.error?.message).toContain("Cannot resolve");
    expect(captured.body?.error?.message).toContain("DNS");
    expect(captured.body?.error?.type).not.toBe("api_error");
  });

  test("a thrown ECONNREFUSED error is surfaced as a 400 connection_error", async () => {
    stubUpstreamThrow(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("connection_error");
    expect(captured.body?.error?.message).toContain("Make sure the server is running");
  });

  test("a thrown connection error is surfaced with a single-line terminal-safe message", async () => {
    stubUpstreamThrow(
      Object.assign(
        new Error(
          "Unable to connect. Is the computer able to access the url?\n\t\u001b[31mconnection failed\u001b[0m"
        ),
        { code: "ConnectionRefused" }
      )
    );
    const { c, captured } = makeContext();
    await makeHandler().handle(c, PAYLOAD);

    const message = captured.body?.error?.message;
    expect(typeof message).toBe("string");
    expect(message).not.toMatch(/[\r\n\t]/);
    expect(message).not.toContain("\u001b");
  });

  test("a non-connection throw propagates without calling c.json", async () => {
    const thrown = new TypeError("Cannot read properties of undefined");
    stubUpstreamThrow(thrown);
    const { c, captured } = makeContext();
    let didReject = false;

    try {
      await makeHandler().handle(c, PAYLOAD);
    } catch (error) {
      didReject = true;
      expect(error).toBe(thrown);
    }

    expect(didReject).toBe(true);
    expect(captured.status).toBeUndefined();
  });
});

type TerminalClassifier = NonNullable<ProviderTransport["classifyTerminalError"]>;

function makeHandlerWithClassifier(classifyTerminalError: TerminalClassifier): ComposedHandler {
  const transport: ProviderTransport = { ...makeTransport(), classifyTerminalError };
  return new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8080, {});
}

describe("ComposedHandler.handle — transport terminality override", () => {
  test("transport-declared transient 429 overrides quota-wording heuristic", async () => {
    const message = "Resource has been exhausted (e.g. check quota).";
    stubUpstream(429, {
      error: { code: 429, message, status: "RESOURCE_EXHAUSTED" },
    });
    let calls = 0;
    const handler = makeHandlerWithClassifier((status, bodyText) => {
      calls += 1;
      expect(status).toBe(429);
      expect(bodyText).toContain(message);
      return false;
    });
    const { c, captured } = makeContext();

    await handler.handle(c, PAYLOAD);

    expect(calls).toBe(1);
    expect(captured.status).toBe(429);
    expect(captured.body?.error?.message).toContain(message);
  });

  test("transport-declared terminal 429 is surfaced as out of quota", async () => {
    stubUpstream(429, { error: { message: "rate limit exceeded, slow down" } });
    const { c, captured } = makeContext();

    await makeHandlerWithClassifier(() => true).handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.type).toBe("invalid_request_error");
    expect(captured.body?.error?.message).toContain("Out of quota");
  });

  test("an undefined transport verdict falls back to generic terminal-429 classification", async () => {
    stubUpstream(429, {
      error: {
        message: "insufficient_quota",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    const { c, captured } = makeContext();

    await makeHandlerWithClassifier(() => undefined).handle(c, PAYLOAD);

    expect(captured.status).toBe(400);
    expect(captured.body?.error?.message).toContain("Out of quota");
    expect(captured.body?.error?.message).toContain("insufficient_quota");
  });
});

const RETRIED_SUCCESS_SSE = [
  `data: ${JSON.stringify({
    id: "chatcmpl-after-refresh",
    object: "chat.completion.chunk",
    created: 1,
    model: "fugu-ultra",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "response from refreshed request" },
        finish_reason: "stop",
      },
    ],
  })}`,
  "data: [DONE]",
  "",
].join("\n\n");

describe("ComposedHandler.handle — 401 auth refresh retry", () => {
  test("calls forceRefreshAuth exactly once, retries once, and returns the retried 200 response", async () => {
    let refreshCalls = 0;
    const calls = stubUpstreamSequence(
      { status: 401, body: { error: { message: "stale token" } } },
      {
        status: 200,
        body: RETRIED_SUCCESS_SSE,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
    const transport = makeTransportWithRefresh(() => {
      refreshCalls += 1;
    });
    const handler = new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8080, {});
    const { c } = makeContext();

    const response = await handler.handle(c, PAYLOAD);
    const body = (await response.json()) as { content?: Array<{ text?: string }> };

    expect(refreshCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(response.status).toBe(200);
    expect(body.content?.[0]?.text).toBe("response from refreshed request");
  });

  test("retries with headers minted after forceRefreshAuth", async () => {
    let refreshed = false;
    const calls = stubUpstreamSequence(
      { status: 401, body: { error: { message: "stale token" } } },
      {
        status: 200,
        body: RETRIED_SUCCESS_SSE,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
    const transport = makeTransportWithRefresh(
      () => {
        refreshed = true;
      },
      async () => ({ Authorization: refreshed ? "Bearer fresh" : "Bearer stale" })
    );
    const handler = new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8080, {});
    const { c } = makeContext();

    const response = await handler.handle(c, PAYLOAD);
    await response.arrayBuffer();

    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer stale");
    expect(new Headers(calls[1]?.init?.headers).get("Authorization")).toBe("Bearer fresh");
  });

  test("refreshes only once when the retried request also returns 401", async () => {
    let refreshCalls = 0;
    const calls = stubUpstreamSequence(
      { status: 401, body: { error: { message: "stale token" } } },
      { status: 401, body: { error: { message: "fresh token rejected too" } } }
    );
    const transport = makeTransportWithRefresh(() => {
      refreshCalls += 1;
    });
    const handler = new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8080, {});
    const { c, captured } = makeContext();

    const response = await handler.handle(c, PAYLOAD);

    expect(refreshCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(response.ok).toBe(false);
    expect(captured.status).toBe(401);
  });

  test("a transport without forceRefreshAuth surfaces a 401 through the generic error path", async () => {
    const calls = stubUpstreamSequence({
      status: 401,
      body: { error: { message: "invalid api key" } },
    });
    const handler = new ComposedHandler(makeTransport(), "fugu-ultra", "fugu-ultra", 8080, {});
    const { c, captured } = makeContext();

    const response = await handler.handle(c, PAYLOAD);

    expect(calls).toHaveLength(1);
    expect(response.ok).toBe(false);
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.message).toContain("Sakana Fugu error (HTTP 401)");
  });
});
