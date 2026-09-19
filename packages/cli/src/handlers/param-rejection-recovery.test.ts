/**
 * `recoverFromRejection` must be reachable for EVERY model, not only the ones a
 * dialect recognises.
 *
 * Item 11 (`b74bab2`) began forwarding `stop_sequences` → `stop` and `top_p` on
 * every OpenAI-shaped builder, and made `recoverFromRejection` concrete on
 * `BaseAPIFormat` so a strict relay's 400 is repaired in one retry. Its commit
 * message claims that wiring landed with it. It did not: the retry gate called
 * `this.modelAdapter.recoverFromRejection` alone, and `ComposedHandler`
 * deliberately leaves `modelAdapter` UNSET when the model resolves to
 * `DefaultAPIFormat` — which `resolveModelDialect` returns for every model no
 * dialect recognises. So the base implementation, written for exactly this case,
 * never ran for it.
 *
 * The population that hurts is the obvious one: a brand-new `vendor/new-model`
 * on a custom OpenAI-compatible endpoint is both the most likely to be
 * unrecognized AND the most likely to meet a relay that rejects `stop`.
 *
 * ## Why these tests drive the HANDLER
 *
 * `adapters/sampling-params-forwarded.test.ts` already pins the adapter method,
 * calling `fmt.recoverFromRejection(...)` directly — and stayed green through
 * the whole gap, because the method was always correct. It was never called.
 * That is the "tests that set up differently from production" shape; the only
 * test that can see this defect is one that goes through `handle()`.
 *
 * ## Provenance of the inputs
 *
 * REQUEST-side, with a stubbed upstream. No capture in the tree is an inbound
 * body or a provider 4xx, so the request and the relay's complaint are written
 * inline. The rejection wording is the documented shape of an OpenAI-compatible
 * relay, NOT captured from a live 4xx — the same labelled limitation
 * `sampling-params-forwarded.test.ts` carries.
 */

import { afterEach, expect, test } from "bun:test";
import type { Context } from "hono";
import { resolveModelDialect } from "../adapters/dialect-manager.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A custom OpenAI-compatible endpoint: openai-sse, no OAuth refresh branch. */
function makeTransport(): ProviderTransport {
  return {
    name: "corp-proxy",
    displayName: "Corp Proxy",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/v1/chat/completions",
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

interface Call {
  body: any;
}

/** Stub fetch with one response per call, retaining each parsed request body. */
function stubUpstream(...responses: Array<{ status: number; body: string }>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const response = responses[calls.length];
    calls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
    if (!response) throw new Error(`Unexpected fetch call ${calls.length}`);
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.status === 200 ? "text/event-stream" : "application/json",
      },
    });
  }) as unknown as typeof fetch;
  return calls;
}

/** The relay's complaint, in a field position so the two detection gates pass. */
const UNKNOWN_STOP = JSON.stringify({ error: { message: "Unknown parameter: 'stop'" } });

/** A minimal, valid openai-sse turn so the retry's 200 streams to completion. */
const OK_STREAM =
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}],"usage":null}\n\n' +
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n' +
  "data: [DONE]\n\n";

function makeContext(): Context {
  return {
    req: { header: () => ({}) },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context;
}

/** Claude Code really does send stop sequences — its classifier requests carry them. */
function claudeRequest(model: string) {
  return {
    model,
    max_tokens: 16,
    stop_sequences: ["END"],
    messages: [{ role: "user", content: "hi" }],
  };
}

/**
 * A model name no dialect in the tree claims, so `resolveModelDialect` answers
 * `DefaultAPIFormat` and `modelAdapter` stays unset. Asserted below rather than
 * assumed — a future dialect that starts matching this name would turn the test
 * green for the wrong reason.
 */
const UNKNOWN_MODEL = "vendor/new-model";

test("the premise holds: this model has no dialect, grok-4 does", () => {
  // Without this, a future dialect matching `vendor/*` would set `modelAdapter`
  // and turn the test below green through the path that never broke.
  expect(resolveModelDialect(UNKNOWN_MODEL).getName()).toBe("DefaultAPIFormat");
  expect(resolveModelDialect("grok-4").getName()).not.toBe("DefaultAPIFormat");
});

test("an unrecognized model still recovers from a rejected `stop`", async () => {
  const calls = stubUpstream({ status: 400, body: UNKNOWN_STOP }, { status: 200, body: OK_STREAM });

  const handler = new ComposedHandler(
    makeTransport(),
    `corp@${UNKNOWN_MODEL}`,
    UNKNOWN_MODEL,
    8080,
    {}
  );
  await handler.handle(makeContext(), claudeRequest(UNKNOWN_MODEL));

  expect(calls.length).toBe(2);
  // The first attempt carried the parameter, speculatively — that is the whole
  // reason a recovery hook exists.
  expect(calls[0].body.stop).toEqual(["END"]);
  // The retry dropped exactly it, and nothing else.
  expect("stop" in calls[1].body).toBe(false);
  expect(calls[1].body.messages).toEqual(calls[0].body.messages);
  expect(calls[1].body.max_tokens).toBe(calls[0].body.max_tokens);
});

test("a 4xx about something else is not retried", async () => {
  // Narrowness matters more than reach here: a missed recovery is a visible
  // failed request, a wrong one silently strips a parameter the model accepted.
  const calls = stubUpstream({
    status: 400,
    body: JSON.stringify({ error: { message: "Rate limit exceeded" } }),
  });

  const handler = new ComposedHandler(
    makeTransport(),
    `corp@${UNKNOWN_MODEL}`,
    UNKNOWN_MODEL,
    8080,
    {}
  );
  await handler.handle(makeContext(), claudeRequest(UNKNOWN_MODEL));

  expect(calls.length).toBe(1);
});

test("a model WITH a dialect still recovers — the pre-existing path is intact", async () => {
  // Grok resolves to GrokModelDialect, so `modelAdapter` is set and this is the
  // path that always worked. Kept as the non-regression half: the fix adds a
  // second candidate, it must not displace the first.
  const calls = stubUpstream({ status: 400, body: UNKNOWN_STOP }, { status: 200, body: OK_STREAM });

  const handler = new ComposedHandler(makeTransport(), "corp@grok-4", "grok-4", 8080, {});
  await handler.handle(makeContext(), claudeRequest("grok-4"));

  expect(calls.length).toBe(2);
  expect(calls[0].body.stop).toEqual(["END"]);
  expect("stop" in calls[1].body).toBe(false);
});
