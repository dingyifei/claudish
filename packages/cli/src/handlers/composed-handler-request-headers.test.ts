// REGRESSION: OpenCode Zen Go 400 MissingSessionID — no x-opencode-session header — Fixed in /dev:fix session dev-fix-20260912-213141-f1fb0c1c
import { afterEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import type { ProviderTransport } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const USER_ID = JSON.stringify({
  device_id: "073c1234567890abcdef1234567890ab",
  account_uuid: "",
  session_id: "ce7d2f89-90c2-4a15-93ed-f2c41b531111",
});

const CLAUDE_REQUEST = {
  model: "fugu-ultra",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
  metadata: { user_id: USER_ID },
};

function makeContext(): Context {
  return {
    req: { header: () => ({}) },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as unknown as Context;
}

function makeRecordingTransport(options: { refresh?: boolean } = {}) {
  const headerArguments: unknown[] = [];
  const transport = {
    name: "sakana",
    displayName: "Sakana Fugu",
    streamFormat: "openai-sse",
    getEndpoint: () => "http://localhost/v1/chat/completions",
    getHeaders: async (claudeRequest?: unknown) => {
      headerArguments.push(claudeRequest);
      return {};
    },
    ...(options.refresh ? { forceRefreshAuth: async () => {} } : {}),
  } as unknown as ProviderTransport;
  return { transport, headerArguments };
}

function stubUpstreamSequence(...statuses: number[]) {
  let call = 0;
  globalThis.fetch = (async () => {
    const status = statuses[call++];
    if (status === undefined) throw new Error(`Unexpected fetch call ${call}`);
    return new Response(JSON.stringify({ error: { message: `upstream ${status}` } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("ComposedHandler request-aware transport headers", () => {
  test("passes the original inbound request to the main getHeaders call", async () => {
    stubUpstreamSequence(400);
    const { transport, headerArguments } = makeRecordingTransport();
    const handler = new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8080, {});

    await handler.handle(makeContext(), CLAUDE_REQUEST);

    expect(headerArguments).toHaveLength(1);
    expect(headerArguments[0]).toEqual(CLAUDE_REQUEST);
    expect((headerArguments[0] as typeof CLAUDE_REQUEST).metadata.user_id).toBe(USER_ID);
  });

  test("passes the original inbound request again on the 401 auth-refresh retry", async () => {
    stubUpstreamSequence(401, 401);
    const { transport, headerArguments } = makeRecordingTransport({ refresh: true });
    const handler = new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8080, {});

    await handler.handle(makeContext(), CLAUDE_REQUEST);

    expect(headerArguments).toEqual([CLAUDE_REQUEST, CLAUDE_REQUEST]);
  });

  test("passes the original inbound request again on a parameter-rejection retry", async () => {
    stubUpstreamSequence(400, 400);
    const { transport, headerArguments } = makeRecordingTransport();
    const handler = new ComposedHandler(transport, "fugu-ultra", "fugu-ultra", 8080, {});
    const adapter = (handler as any).getAdapter();
    adapter.recoverFromRejection = (payload: unknown) => ({
      payload,
      note: "remove rejected parameter",
    });
    (handler as any).modelAdapter = adapter;

    await handler.handle(makeContext(), CLAUDE_REQUEST);

    expect(headerArguments).toEqual([CLAUDE_REQUEST, CLAUDE_REQUEST]);
  });
});
