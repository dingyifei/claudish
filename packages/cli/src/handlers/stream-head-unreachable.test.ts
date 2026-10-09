import { afterEach, expect, test } from "bun:test";
import { type Context, Hono } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";
import { FallbackHandler, isRetryableError } from "./fallback-handler.js";
import { CONNECTION_FAULT_HEADER, RECOVERY_MARKER_VALUE } from "./shared/recovery-marker.js";
import type { ModelHandler } from "./types.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeTransport(): ProviderTransport {
  return {
    name: "sakana",
    displayName: "Codex",
    streamFormat: "openai-responses-sse",
    overrideStreamFormat: () => "openai-responses-sse",
    getEndpoint: () => "https://api.sakana.example/v1/responses",
    getHeaders: async () => ({}),
  } as unknown as ProviderTransport;
}

function makeContext(): Context {
  return {
    req: {
      header: (name?: string) =>
        name === undefined ? {} : name === "x-claudish-no-recovery" ? "1" : undefined,
    },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    // Preserve the third argument: it carries the connection-fault verdict.
    json: (body: unknown, status = 200, headers?: HeadersInit) =>
      new Response(JSON.stringify(body), { status, headers }),
  } as unknown as Context;
}

const PAYLOAD = {
  model: "fugu-ultra",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

function makeHandler(): ComposedHandler {
  return new ComposedHandler(makeTransport(), PAYLOAD.model, PAYLOAD.model, 8080, {});
}

function overloadedStream(): Response {
  const events = [
    { type: "response.created", response: { id: "resp_test", status: "in_progress" } },
    { type: "response.in_progress", response: { id: "resp_test", status: "in_progress" } },
    {
      type: "error",
      error: { code: "server_is_overloaded", message: "Server is overloaded" },
      sequence_number: 2,
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function stubFetch(unreachable: boolean): () => number {
  let calls = 0;
  const unrelatedUrls: string[] = [];
  globalThis.fetch = (async (input: string | Request | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://api.sakana.example/v1/responses") {
      unrelatedUrls.push(url);
      return new Response("{}", { status: 404 });
    }
    calls++;
    if (calls === 1) return overloadedStream();
    if (calls !== 2) throw new Error(`Unexpected fetch call ${calls}`);
    if (unreachable) {
      throw Object.assign(new TypeError("fetch failed"), { code: "ConnectionRefused" });
    }
    return new Response('{"error":{"message":"upstream overloaded"}}', { status: 503 });
  }) as unknown as typeof fetch;
  return () => calls;
}

async function runInChain(first: ModelHandler) {
  let nextCalls = 0;
  const second = {
    async handle() {
      nextCalls++;
      return new Response('{"content":[{"type":"text","text":"ok"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    shutdown: async () => {},
  } as ModelHandler;
  const handler = new FallbackHandler([
    { name: "Codex", handler: first },
    { name: "Metered candidate", handler: second },
  ]);
  const app = new Hono();
  app.post("/test", (c) => handler.handle(c, PAYLOAD));
  const response = await app.request("/test", {
    method: "POST",
    headers: { "x-claudish-no-recovery": "1" },
    body: "{}",
  });
  return { response, nextCalls };
}

test("a re-issue that cannot reach the provider answers 503 with the connection-fault header", async () => {
  const calls = stubFetch(true);
  const response = await makeHandler().handle(makeContext(), PAYLOAD);
  const body = await response.text();
  expect(calls()).toBe(2);
  expect(response.status).toBe(503);
  expect(response.headers.get(CONNECTION_FAULT_HEADER)).toBe(RECOVERY_MARKER_VALUE);
  expect(JSON.parse(body).error.type).toBe("overloaded_error");
  expect(isRetryableError(503, body, "Codex", response.headers)).toBe(false);
}, 20_000);

test("a routing chain holds on that 503 and never calls the next candidate", async () => {
  const calls = stubFetch(true);
  const { response, nextCalls } = await runInChain(makeHandler());
  expect(calls()).toBe(2);
  expect(response.status).toBe(503);
  expect(response.headers.get(CONNECTION_FAULT_HEADER)).toBe(RECOVERY_MARKER_VALUE);
  expect(nextCalls).toBe(0);
}, 20_000);

test("a re-issue that gets an HTTP answer stays unmarked, so the chain advances", async () => {
  const singleCalls = stubFetch(false);
  const single = await makeHandler().handle(makeContext(), PAYLOAD);
  expect(singleCalls()).toBe(2);
  expect(single.status).toBe(503);
  expect(single.headers.has(CONNECTION_FAULT_HEADER)).toBe(false);

  const chainCalls = stubFetch(false);
  const { response, nextCalls } = await runInChain(makeHandler());
  expect(chainCalls()).toBe(2);
  expect(nextCalls).toBe(1);
  expect(response.status).toBe(200);
}, 20_000);
