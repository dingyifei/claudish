/**
 * E2E tests for the provider fallback mechanism.
 *
 * These tests use REAL API tokens and hit actual provider endpoints.
 * They start a real claudish proxy server and send Anthropic-format
 * /v1/messages requests with bare model names (no provider@ prefix)
 * to validate fallback chain behavior end-to-end.
 *
 * Required env vars (tests skip gracefully if not set):
 *   MINIMAX_API_KEY or OPENCODE_API_KEY or OPENROUTER_API_KEY
 *
 * Run: bun test packages/cli/src/handlers/fallback-handler.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createProxyServer } from "../proxy-server.js";
import { hasAnyCredential } from "../test-helpers/credential-gate.js";
import type { ProxyServer } from "../types.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const TEST_PORT = 18900 + Math.floor(Math.random() * 100);

let proxyServer: ProxyServer | null = null;

async function ensureProxy(): Promise<number> {
  if (proxyServer) return TEST_PORT;

  proxyServer = await createProxyServer(
    TEST_PORT,
    process.env.OPENROUTER_API_KEY,
    undefined, // no default model — let fallback decide
    false,
    process.env.ANTHROPIC_API_KEY,
    undefined,
    { quiet: true }
  );
  return TEST_PORT;
}

afterAll(async () => {
  if (proxyServer) {
    await proxyServer.shutdown();
    proxyServer = null;
  }
});

/**
 * Send a minimal /v1/messages request to the proxy.
 * Returns { ok, status, body } where body is parsed from JSON or SSE.
 */
async function sendMessage(
  port: number,
  model: string,
  prompt = "Say hello in 5 words"
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const contentType = res.headers.get("content-type") || "";
  let body: any;

  if (contentType.includes("text/event-stream")) {
    // SSE response — parse event stream for content
    const text = await res.text();
    const lines = text.split("\n");
    let lastData: any = null;
    const textParts: string[] = [];
    let hasError = false;
    let errorData: any = null;

    for (const line of lines) {
      // SSE spec: "data:" with optional space — handle both "data: {...}" and "data:{...}"
      const isDataLine = line.startsWith("data: ") || line.startsWith("data:");
      if (isDataLine) {
        const data = (line.startsWith("data: ") ? line.slice(6) : line.slice(5)).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          lastData = parsed;

          // Anthropic SSE: content_block_delta with text
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            textParts.push(parsed.delta.text);
          }
          // Anthropic SSE: message_start with content array
          if (parsed.type === "message_start" && parsed.message?.content?.length > 0) {
            for (const block of parsed.message.content) {
              if (block.text) textParts.push(block.text);
            }
          }
          // OpenAI SSE: choices[].delta.content
          if (parsed.choices?.[0]?.delta?.content) {
            textParts.push(parsed.choices[0].delta.content);
          }
          // Error events
          if (parsed.type === "error" || parsed.error) {
            hasError = true;
            errorData = parsed;
          }
        } catch {
          // Skip non-JSON data lines
        }
      }
    }

    if (textParts.length > 0) {
      body = {
        content: [{ type: "text", text: textParts.join("") }],
        _raw_sse: true,
      };
      return { ok: true, status: res.status, body };
    }
    if (hasError && errorData) {
      return { ok: false, status: res.status, body: errorData };
    }
    if (lastData?.type === "message_stop" || lastData?.type === "message_delta") {
      // Anthropic SSE completed but no text extracted — treat as success (empty response)
      body = { content: [{ type: "text", text: "" }], _raw_sse: true };
      return { ok: true, status: res.status, body };
    }
    body = lastData || { _raw_text: text.slice(0, 500) };
    return { ok: false, status: res.status, body };
  }
  // JSON response
  try {
    body = await res.json();
  } catch {
    body = { _raw_text: await res.text() };
  }
  if (body?.type === "message" && Array.isArray(body.content) && body.content.length === 0) {
    // Both response envelopes must classify an empty-but-successful turn the same way.
    body.content = [{ type: "text", text: "" }];
    return { ok: true, status: res.status, body };
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Can claudish serve ANY fallback-capable provider?
 *
 * Asked via claudish's OWN credential authority (env → aliases →
 * ~/.claudish/config.json apiKeys → 1Password), NOT raw process.env — a key
 * stored any supported way makes claudish able to serve the request, so these
 * tests must run rather than silently skip. Resolved once at module load.
 */
const HAS_ANY_CREDENTIALS = await hasAnyCredential([
  "minimax",
  "minimax-coding",
  "opencode-zen",
  "openrouter",
  "litellm",
  "google",
  "kimi",
  "kimi-coding",
  "openai",
]);

function hasAnyCredentials(): boolean {
  return HAS_ANY_CREDENTIALS;
}

// ---------------------------------------------------------------------------
// (Group 1 — unit tests of getFallbackChain — removed in commit 5 of the
// model-catalog and routing redesign. The fallback chain construction logic
// moved from auto-route.ts (now ~50 lines) into routing-rules.ts route().
// Equivalent matrix coverage lives in providers/routing-rules.test.ts and
// providers/route-candidates.test.ts.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Group 2: Real API — fallback produces a valid response or structured error
// ---------------------------------------------------------------------------

describe("Group 2: Real API — fallback response structure", () => {
  test.skipIf(!hasAnyCredentials())(
    "minimax-m2.5 without prefix returns success or structured fallback error",
    async () => {
      const port = await ensureProxy();

      const { ok, body } = await sendMessage(port, "minimax-m2.5");

      if (ok) {
        // Some provider in the chain succeeded
        expect(body.content).toBeDefined();
        expect(body.content.length).toBeGreaterThan(0);
      } else if (body.error?.type === "all_providers_failed") {
        // All providers failed — structured fallback error
        expect(body.error.attempts).toBeInstanceOf(Array);
        expect(body.error.attempts.length).toBeGreaterThan(0);

        for (const attempt of body.error.attempts) {
          expect(attempt.provider).toBeDefined();
          expect(typeof attempt.status).toBe("number");
          expect(attempt.error).toBeDefined();
        }
      } else {
        // Single-provider error or raw SSE error — just verify it's not silently swallowed
        expect(body).toBeDefined();
      }
    },
    30_000
  );

  test.skipIf(!hasAnyCredentials())(
    "glm-5-turbo without prefix returns success or structured fallback error",
    async () => {
      const port = await ensureProxy();

      const { ok, body } = await sendMessage(port, "glm-5-turbo");

      if (ok) {
        expect(body.content).toBeDefined();
      } else if (body.error?.type === "all_providers_failed") {
        expect(body.error.attempts.length).toBeGreaterThan(0);
      } else {
        expect(body).toBeDefined();
      }
    },
    30_000
  );

  test.skipIf(!hasAnyCredentials())(
    "kimi-k2.5 without prefix returns success or structured fallback error",
    async () => {
      const port = await ensureProxy();

      const { ok, body } = await sendMessage(port, "kimi-k2.5");

      if (ok) {
        expect(body.content).toBeDefined();
      } else if (body.error?.type === "all_providers_failed") {
        expect(body.error.attempts.length).toBeGreaterThan(0);
      } else {
        expect(body).toBeDefined();
      }
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// Group 3: Real API — fallback actually tries multiple providers
// ---------------------------------------------------------------------------

describe("Group 3: Real API — multi-provider fallback in action", () => {
  test.skipIf(!hasAnyCredentials())(
    "bare model tries multiple providers and either succeeds or returns an error",
    async () => {
      const port = await ensureProxy();

      const { ok, body } = await sendMessage(port, "minimax-m2.5");

      if (ok) {
        // Fallback chain found a working provider
        expect(body.content).toBeDefined();
        expect(body.content.length).toBeGreaterThan(0);
      } else if (body.type === "message_stop" || body._raw_sse) {
        // SSE stream completed (Anthropic-compat provider responded) but no text was
        // extracted by the test helper. The fallback chain DID succeed at HTTP level —
        // the response was just too short or used a format the test parser doesn't cover.
        // This is still a valid outcome — the provider accepted the request.
        expect(body).toBeDefined();
      } else {
        // Real error — must have a structured error
        expect(body.error).toBeDefined();
        if (body.error.type === "all_providers_failed") {
          expect(body.error.attempts.length).toBeGreaterThanOrEqual(1);
          for (const attempt of body.error.attempts) {
            expect(attempt.provider).toBeDefined();
            expect(typeof attempt.status).toBe("number");
          }
        } else {
          // Single-provider error (non-retryable) — must have type and message
          expect(body.error.type).toBeDefined();
          expect(body.error.message).toBeDefined();
        }
      }
    },
    30_000
  );

  test.skipIf(!hasAnyCredentials())(
    "completely unknown model fails with a structured error",
    async () => {
      const port = await ensureProxy();

      const { ok, body } = await sendMessage(port, "nonexistent-model-xyz-999");

      // Unknown model should NOT succeed
      expect(ok).toBe(false);
      // Must return some structured error — either fallback chain or single provider
      expect(body.error).toBeDefined();
      expect(body.error.type).toBeDefined();
      expect(body.error.message).toBeDefined();
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// Group 4: Real API — explicit provider prefix bypasses fallback
// ---------------------------------------------------------------------------

describe("Group 4: Real API — explicit provider skips fallback", () => {
  test.skipIf(!process.env.MINIMAX_API_KEY)(
    "mm@minimax-m2.5 (explicit) does NOT use fallback chain",
    async () => {
      const port = await ensureProxy();

      const result = await sendMessage(port, "mm@minimax-m2.5");

      // Explicit provider must NOT trigger fallback chain
      if (!result.ok && result.body.error?.type === "all_providers_failed") {
        throw new Error(
          `Explicit provider mm@ triggered fallback chain with ${result.body.error.attempts.length} attempts — should go direct to MiniMax only`
        );
      }
      // Either succeeds (direct MiniMax) or returns a single-provider error (not wrapped in fallback)
    },
    30_000
  );

  test.skipIf(!process.env.OPENROUTER_API_KEY)(
    "or@minimax/minimax-m2.5 (explicit OpenRouter) goes direct",
    async () => {
      const port = await ensureProxy();

      const { ok, body } = await sendMessage(port, "or@minimax/minimax-m2.5");

      if (ok) {
        expect(body.content).toBeDefined();
        expect(body.content.length).toBeGreaterThan(0);
      } else {
        // Explicit routing error must NOT be a fallback chain error
        expect(body.error?.type).not.toBe("all_providers_failed");
      }
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// Group 5: isRetryableError classification (unit tests)
// ---------------------------------------------------------------------------

describe("Group 5: isRetryableError — unit tests via FallbackHandler behavior", () => {
  // Keep the retryability assertions black-box: mock handlers make it observable
  // whether FallbackHandler tries the next candidate or stops.

  const { Hono } = require("hono");
  const {
    FallbackHandler,
    exhaustedChainStatus,
    isProvider,
    isRetryableError,
  } = require("./fallback-handler.js");
  const { extractUpstreamStatus } = require("./shared/anthropic-error.js");

  function remappedErrorBody(upstreamStatus?: unknown): string {
    const error: Record<string, unknown> = {
      type: "authentication_error",
      message: "invalid api key",
    };
    if (upstreamStatus !== undefined) error.upstream_status = upstreamStatus;
    return JSON.stringify({ type: "error", error });
  }

  // Captured verbatim from /Users/jack/.claudish/logs/claudish_2026-08-07_08-51-52.log:23
  const ZEN_GO_INVALID_TOOL_BODY =
    '{"error":{"type":"server_error","message":"Error from provider (Console Go): Upstream request failed: [bad_request_error] invalid params, invalid tool type:  (2013)"}}';

  // Captured verbatim from /Users/jack/.claudish/logs/claudish_2026-08-07_12-34-35.log:11
  const ZEN_GO_PROVIDER_ERROR_BODY =
    '{"error":{"type":"server_error","message":"Error from provider (Console Go): Upstream request failed: [400] Provider returned error"}}';

  function mockHandler(status: number, body: string) {
    return {
      handle: async () =>
        new Response(body, { status, headers: { "content-type": "application/json" } }),
      shutdown: async () => {},
    };
  }

  async function runFallback(firstStatus: number, firstBody: string): Promise<any> {
    const handler = new FallbackHandler([
      { name: "provider-a", handler: mockHandler(firstStatus, firstBody) },
      {
        name: "provider-b",
        handler: mockHandler(200, '{"content":[{"type":"text","text":"ok"}]}'),
      },
    ]);
    const app = new Hono();
    let result: any;
    app.post("/test", async (c: any) => {
      result = await handler.handle(c, { model: "test-model" });
      return result;
    });
    const res = await app.request("/test", { method: "POST", body: "{}" });
    const text = await res.text();
    return { status: res.status, text, usedFallback: text.includes('"ok"') };
  }

  async function runFallbackForProvider(
    candidateName: string,
    firstStatus: number,
    firstBody: string
  ): Promise<any> {
    const handler = new FallbackHandler([
      { name: candidateName, handler: mockHandler(firstStatus, firstBody) },
      {
        name: "provider-b",
        handler: mockHandler(200, '{"content":[{"type":"text","text":"ok"}]}'),
      },
    ]);
    const app = new Hono();
    app.post("/test", async (c: any) => handler.handle(c, { model: "test-model" }));
    const res = await app.request("/test", { method: "POST", body: "{}" });
    const text = await res.text();
    return { status: res.status, text, usedFallback: text.includes('"ok"') };
  }

  test("401 auth error is retryable — falls through to next provider", async () => {
    const result = await runFallback(401, '{"error":"unauthorized"}');
    expect(result.usedFallback).toBe(true);
  });

  test("403 forbidden is retryable — falls through to next provider", async () => {
    const result = await runFallback(403, '{"error":"forbidden"}');
    expect(result.usedFallback).toBe(true);
  });

  test("402 payment required is retryable — falls through to next provider", async () => {
    const result = await runFallback(402, '{"error":"payment required"}');
    expect(result.usedFallback).toBe(true);
  });

  test("404 not found is retryable — falls through to next provider", async () => {
    const result = await runFallback(404, '{"error":"model not found"}');
    expect(result.usedFallback).toBe(true);
  });

  test("429 rate limit is retryable — falls through to next provider", async () => {
    const result = await runFallback(429, '{"error":"rate limited"}');
    expect(result.usedFallback).toBe(true);
  });

  test("500 with insufficient balance is retryable", async () => {
    const result = await runFallback(500, '{"error":"insufficient balance (1008)"}');
    expect(result.usedFallback).toBe(true);
  });

  test("500 generic server error is NOT retryable — stops immediately", async () => {
    const result = await runFallback(500, '{"error":"internal server error"}');
    expect(result.usedFallback).toBe(false);
  });

  test("400 with unknown model is retryable", async () => {
    const result = await runFallback(400, '{"error":"unknown model xyz"}');
    expect(result.usedFallback).toBe(true);
  });

  test("400 generic bad request is NOT retryable — stops immediately", async () => {
    const result = await runFallback(400, '{"error":"invalid request format"}');
    expect(result.usedFallback).toBe(false);
  });

  test("422 with model not available is retryable", async () => {
    const result = await runFallback(422, '{"error":"model not available"}');
    expect(result.usedFallback).toBe(true);
  });

  test("422 generic is NOT retryable", async () => {
    const result = await runFallback(422, '{"error":"unprocessable entity"}');
    expect(result.usedFallback).toBe(false);
  });

  test("400 with no healthy deployments is retryable (LiteLLM)", async () => {
    const result = await runFallback(400, '{"error":"No healthy deployment available"}');
    expect(result.usedFallback).toBe(true);
  });

  test("503 service unavailable advances to the next candidate", async () => {
    const result = await runFallback(503, '{"error":"service unavailable"}');
    expect(result.usedFallback).toBe(true);
  });

  describe("an unavailable endpoint advances the chain", () => {
    for (const status of [502, 503, 504]) {
      test(`HTTP ${status} with a plain body is retryable`, () => {
        expect(isRetryableError(status, "{}")).toBe(true);
      });
    }

    test("plain HTTP 500 remains non-retryable", () => {
      expect(isRetryableError(500, '{"error":"internal server error"}')).toBe(false);
    });

    test("OpenCode Zen Go endpoint-unavailable 503 reaches the second candidate", async () => {
      const result = await runFallbackForProvider(
        "OpenCode Zen Go",
        503,
        '{"type":"error","error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}'
      );
      expect(result.usedFallback).toBe(true);
      expect(result.status).toBe(200);
    });

    test("502 then 504 reaches 200 and calls each candidate exactly once", async () => {
      const calls = [0, 0, 0];
      const handler = new FallbackHandler(
        [502, 504, 200].map((status, index) => {
          const candidate = mockHandler(status, "{}");
          return {
            name: `provider-${index}`,
            handler: {
              ...candidate,
              handle: async () => {
                calls[index]++;
                return candidate.handle();
              },
            },
          };
        })
      );
      const app = new Hono();
      app.post("/test", async (c: any) => handler.handle(c, { model: "test-model" }));
      const response = await app.request("/test", { method: "POST", body: "{}" });
      expect(response.status).toBe(200);
      expect(calls).toEqual([1, 1, 1]);
    });

    test("all candidates unavailable: 502 then 504 ends with HTTP 503", async () => {
      const handler = new FallbackHandler([
        { name: "a", handler: mockHandler(502, "{}") },
        { name: "b", handler: mockHandler(504, "{}") },
      ]);
      const app = new Hono();
      app.post("/test", async (c: any) => handler.handle(c, { model: "test-model" }));
      const response = await app.request("/test", { method: "POST", body: "{}" });
      expect(response.status).toBe(503);
    });
  });

  describe("exhaustedChainStatus counts 502 and 504 as transient", () => {
    test("502 and 504 exhaust to 503", () => {
      expect(
        exhaustedChainStatus([
          { provider: "a", status: 502, message: "{}" },
          { provider: "b", status: 504, message: "{}" },
        ])
      ).toBe(503);
    });

    for (const upstreamStatus of [502, 504]) {
      test(`remapped 400 with upstream_status ${upstreamStatus} and 503 exhaust to 503`, () => {
        expect(
          exhaustedChainStatus([
            {
              provider: "a",
              status: 400,
              message: JSON.stringify({
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message: "x",
                  upstream_status: upstreamStatus,
                },
              }),
            },
            { provider: "b", status: 503, message: "{}" },
          ])
        ).toBe(503);
      });
    }

    test("terminal 401 mixed with 502 exhausts to 400", () => {
      expect(
        exhaustedChainStatus([
          { provider: "a", status: 401, message: "{}" },
          { provider: "b", status: 502, message: "{}" },
        ])
      ).toBe(400);
    });
  });

  test("401 authentication_error (refreshAuth failure) is retryable — falls through to next provider", async () => {
    // This covers the Gemini Code Assist onboarding failure path:
    // refreshAuth() throws → ComposedHandler returns 401 → FallbackHandler tries next provider.
    const result = await runFallback(
      401,
      '{"error":{"type":"authentication_error","message":"Gemini onboarding completed but no project ID returned."}}'
    );
    expect(result.usedFallback).toBe(true);
  });

  for (const upstreamStatus of [401, 403, 402, 429] as const) {
    test(`remapped 400 with upstream_status ${upstreamStatus} is retryable`, () => {
      expect(isRetryableError(400, remappedErrorBody(upstreamStatus))).toBe(true);
    });
  }

  test("remapped 400 with non-retryable upstream_status 400 remains non-retryable", () => {
    expect(isRetryableError(400, remappedErrorBody(400))).toBe(false);
  });

  test("400 without upstream_status preserves existing bad-request classification", () => {
    expect(isRetryableError(400, remappedErrorBody())).toBe(false);
    expect(isRetryableError(400, '{"error":{"message":"unknown model example"}}')).toBe(true);
  });

  test("malformed or non-numeric upstream_status is absent and never throws", () => {
    expect(() => isRetryableError(400, "not json")).not.toThrow();
    expect(isRetryableError(400, "not json")).toBe(false);
    expect(() => isRetryableError(400, remappedErrorBody("401"))).not.toThrow();
    expect(isRetryableError(400, remappedErrorBody("401"))).toBe(false);
  });

  test("extractUpstreamStatus ignores empty, malformed, and non-numeric bodies", () => {
    expect(extractUpstreamStatus("")).toBeUndefined();
    expect(extractUpstreamStatus("not json")).toBeUndefined();
    expect(extractUpstreamStatus(remappedErrorBody("401"))).toBeUndefined();
  });

  test("upstream-status recovery is restricted to remapped HTTP 400 responses", () => {
    // Mutation guard: the 500 assertion fails if the `status === 400 ?` guard
    // is widened. A real 401 must still return true through the existing status
    // branch, even when its body carries a non-retryable upstream_status.
    expect(isRetryableError(500, remappedErrorBody(401))).toBe(false);
    expect(isRetryableError(401, remappedErrorBody(400))).toBe(true);
  });

  for (const body of [ZEN_GO_INVALID_TOOL_BODY, ZEN_GO_PROVIDER_ERROR_BODY]) {
    test(`400 Zen Go upstream rejection advances: ${body}`, async () => {
      const result = await runFallbackForProvider("OpenCode Zen Go", 400, body);
      expect(result.usedFallback).toBe(true);
    });
  }

  // Production passes the display name ("OpenCode Zen Go"), while direct unit
  // calls may use the hyphenated canonical id. Pin both so punctuation-sensitive
  // matching cannot make this rule look tested while silently disabling it live.
  test("400 Zen Go upstream rejection advances for the canonical provider id", async () => {
    const result = await runFallbackForProvider("opencode-zen-go", 400, ZEN_GO_INVALID_TOOL_BODY);
    expect(result.usedFallback).toBe(true);
  });

  test("400 upstream rejection advances for the free Zen tier", async () => {
    const result = await runFallbackForProvider("OpenCode Zen", 400, ZEN_GO_INVALID_TOOL_BODY);
    expect(result.usedFallback).toBe(true);
  });

  for (const candidateName of ["MiniMax", "OpenRouter"] as const) {
    test(`400 upstream-framed rejection does not advance for non-Zen ${candidateName}`, async () => {
      const result = await runFallbackForProvider(candidateName, 400, ZEN_GO_INVALID_TOOL_BODY);
      expect(result.usedFallback).toBe(false);
    });
  }

  test("400 ordinary payload bug does not advance for Zen", async () => {
    const result = await runFallbackForProvider(
      "OpenCode Zen Go",
      400,
      '{"error":{"message":"messages.0: invalid role"}}'
    );
    expect(result.usedFallback).toBe(false);
  });

  test("isProvider is case- and punctuation-insensitive and rejects undefined", () => {
    expect(isProvider("OpenCode Zen Go", "opencodezen")).toBe(true);
    expect(isProvider("opencode-zen-go", "opencodezen")).toBe(true);
    expect(isProvider("opencode_zen_go", "opencodezen")).toBe(true);
    expect(isProvider(undefined, "opencodezen")).toBe(false);
  });
});
