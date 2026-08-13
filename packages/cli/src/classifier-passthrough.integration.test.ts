// HTTP-level integration test for classifier passthrough. Drives the REAL proxy
// server over loopback and stubs the outbound `fetch` so NativeHandler's call to
// api.anthropic.com is intercepted — no real network, no credentials. Validates
// the routing short-circuit end to end: reroute to native, model rewrite,
// `thinking` preservation, and verbatim forwarding of the system array (incl.
// the billing block) and the inbound OAuth header.
//
// The stub REJECTS payloads the real API rejects (see anthropicStubResponse).
// A stub that answered 200 to everything would stay green while claudish sent
// bodies Anthropic 400s — which is precisely how the `thinking`-deletion bug
// survived: the old fixture asserted the field was gone and nothing checked
// what that meant on the wire.

import { afterEach, describe, expect, test } from "bun:test";
import { createProxyServer } from "./proxy-server.js";

const realFetch = globalThis.fetch.bind(globalThis);

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Stand-in for api.anthropic.com's request validation on the 5-family models
 * this passthrough rewrites onto. Only the rules that bite here are modelled:
 *   - `thinking: {type:"enabled", budget_tokens}` was removed → 400
 *   - non-default `temperature` / `top_p` / `top_k` → 400
 * Everything else gets the canned allow-verdict a classifier call would return.
 */
function anthropicStubResponse(body: Record<string, unknown>): Response {
  const reject = (message: string) =>
    new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      }
    );

  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  if (thinking?.type === "enabled" || thinking?.budget_tokens !== undefined) {
    return reject("thinking.budget_tokens is not supported on this model");
  }
  for (const p of ["temperature", "top_p", "top_k"]) {
    if (body[p] !== undefined) return reject(`${p} is not supported on this model`);
  }

  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "allow" }],
      stop_reason: "end_turn",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/** Replace global fetch: capture + canned-answer api.anthropic.com, neutralize everything else. */
function stubFetch(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes("api.anthropic.com")) {
      const headers: Record<string, string> = {};
      const h = (init?.headers ?? {}) as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
      const body = JSON.parse(init?.body as string);
      calls.push({ url, headers, body });
      return anthropicStubResponse(body);
    }
    // Neutralize background warmers (pricing / recommended / catalog) and anything else.
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

/**
 * Shape of a real auto-mode classifier request, from a live capture at Claude
 * Code 2.1.226: non-streaming, tool-less, `max_tokens: 64`, thinking explicitly
 * DISABLED, no sampling params, and a multi-block system array whose first
 * block is the billing header. Content is redacted; only structure matters here.
 *
 * Note the arriving model is already `claude-sonnet-5` — the classifier stopped
 * carrying the session model id. It is still misrouted without the passthrough,
 * because a bare Claude id is resolved by ROLE to whatever that tier maps to.
 */
const CLASSIFIER_BODY = {
  model: "claude-sonnet-5",
  thinking: { type: "disabled" },
  max_tokens: 64,
  system: [
    { type: "text", text: "x-anthropic-billing-header: opaque-billing-token" },
    {
      type: "text",
      text: "You are a security monitor for autonomous AI coding agents. Decide whether the tool call is safe.",
    },
    { type: "text", text: "\n\n## Session Context\n\n[…redacted…]" },
  ],
  messages: [{ role: "user", content: "[…redacted…]" }],
};

describe("classifier passthrough (HTTP)", () => {
  let proxy: Awaited<ReturnType<typeof createProxyServer>> | null = null;

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (proxy) await proxy.shutdown();
    proxy = null;
  });

  test("reroutes classifier → native: rewrites model, preserves thinking + system + OAuth", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
      classifier: { enabled: true, model: "claude-sonnet-5" },
    });

    const res = await realFetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-oauth-token",
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(CLASSIFIER_BODY),
    });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const fwd = calls[0];
    expect(fwd.url).toContain("api.anthropic.com/v1/messages");
    // Model rewritten to the configured classifier model.
    expect(fwd.body.model).toBe("claude-sonnet-5");
    // thinking PRESERVED as sent. Deleting it would omit the field, and an
    // omitted `thinking` makes Claude 5 models run adaptive thinking — which
    // with max_tokens:64 would consume the budget and truncate the verdict.
    expect(fwd.body.thinking).toEqual({ type: "disabled" });
    // No sampling params reach the model (they are rejected on 5-family models).
    expect(fwd.body.temperature).toBeUndefined();
    // system array forwarded VERBATIM, including the x-anthropic-billing-header block.
    expect(fwd.body.system).toEqual(CLASSIFIER_BODY.system);
    // Inbound Claude Max OAuth + anthropic-beta forwarded to Anthropic.
    expect(fwd.headers.authorization).toBe("Bearer test-oauth-token");
    expect(fwd.headers["anthropic-beta"]).toContain("claude-code-20250219");
  });

  test("does NOT rewrite a non-classifier request (model + thinking preserved)", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
      classifier: { enabled: true, model: "claude-sonnet-5" },
    });

    // Main-loop shape from the same capture: adaptive thinking, streaming-sized
    // budget. `enabled`+budget_tokens would be rejected by the stub, correctly —
    // Claude Code does not send that shape to a 5-family model.
    const normalBody = {
      model: "claude-opus-4-8",
      thinking: { type: "adaptive" },
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 64000,
    };
    const res = await realFetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-oauth-token" },
      body: JSON.stringify(normalBody),
    });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1); // claude-opus-4-8 is itself native → still hits Anthropic...
    expect(calls[0].body.model).toBe("claude-opus-4-8"); // ...but NOT rewritten
    expect(calls[0].body.thinking).toEqual(normalBody.thinking); // and thinking preserved
  });

  test("opt-in off: classifier-shaped request is NOT rewritten", async () => {
    const calls = stubFetch();
    proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
      quiet: true,
      classifier: { enabled: false, model: "claude-sonnet-5" },
    });

    const res = await realFetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-oauth-token" },
      body: JSON.stringify(CLASSIFIER_BODY),
    });

    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    // Compared against the fixture rather than a literal: the point is "byte-for-byte
    // what the client sent", which stays true when the captured shape drifts again.
    expect(calls[0].body.model).toBe(CLASSIFIER_BODY.model); // untouched — gate is off
    expect(calls[0].body.thinking).toEqual(CLASSIFIER_BODY.thinking); // untouched
  });
});
