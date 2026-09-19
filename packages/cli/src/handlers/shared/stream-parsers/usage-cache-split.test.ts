/**
 * Item 6 — the prompt-token split, against a REAL capture.
 *
 * Every number asserted below is READ OUT OF a committed `.sse` capture, never
 * written by hand: `grok-4.6-openai-advisor-turn1.sse` carries
 * `prompt_tokens: 20379` with `prompt_tokens_details.cached_tokens: 20352`, which
 * is the extreme case the split exists for — 99.9% of the context served from
 * cache. The OpenRouter captures supply the `cache_write_tokens` spelling.
 *
 * The end-to-end half replays the capture through the real parser and reads the
 * emitted `message_delta`, so it sees the wire bytes a client would.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Context } from "hono";

import { DefaultAPIFormat } from "../../../adapters/base-api-format.js";
import { createStreamingResponseHandler } from "./openai-sse.js";
import { splitPromptTokens } from "./usage-cache-split.js";

const CACHED_TURN = new URL(
  "../../../test-fixtures/sse-responses/grok-4.6-openai-advisor-turn1.sse",
  import.meta.url
);
const OPENROUTER_TURN = new URL(
  "../../../test-fixtures/sse-responses/gemini-3.1-pro-or-maxtokens-empty.sse",
  import.meta.url
);

/** Pull the LAST `usage` object out of a capture, exactly as the parser does. */
function capturedUsage(url: URL): Record<string, any> {
  const wire = readFileSync(url, "utf8");
  let found: Record<string, any> | undefined;
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk.usage) found = chunk.usage;
    } catch {
      // Not every data line is a chunk; the parser tolerates that too.
    }
  }
  if (!found) throw new Error(`No usage object in ${url.pathname}`);
  return found;
}

function createMockContext(): Context {
  return {
    body(stream: ReadableStream, init?: ResponseInit) {
      return new Response(stream, init);
    },
    json() {
      throw new Error("Unexpected no-body error path");
    },
  } as unknown as Context;
}

async function closingUsage(url: URL): Promise<Record<string, number>> {
  const upstream = new Response(readFileSync(url, "utf8"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const out = await createStreamingResponseHandler(
    createMockContext(),
    upstream,
    new DefaultAPIFormat("test-model"),
    "test-model",
    null
  ).text();

  let usage: Record<string, number> | undefined;
  for (const part of out.split("\n\n")) {
    const data = part
      .split("\n")
      .find((l) => l.startsWith("data: "))
      ?.slice(6);
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data);
    if (parsed?.type === "message_delta") usage = parsed.usage;
  }
  if (!usage) throw new Error("no message_delta usage");
  return usage;
}

describe("splitPromptTokens — against real captures", () => {
  test("A: the xAI capture splits 20379 into 27 fresh + 20352 cached", () => {
    const usage = capturedUsage(CACHED_TURN);
    // Provenance guard: if the fixture is ever replaced, this test must fail
    // loudly rather than assert the new file's numbers as if they were these.
    expect(usage.prompt_tokens).toBe(20379);
    expect(usage.prompt_tokens_details.cached_tokens).toBe(20352);

    const split = splitPromptTokens(usage);
    expect(split.promptTokens).toBe(20379);
    expect(split.inputTokens).toBe(27);
    expect(split.cacheReadTokens).toBe(20352);
    expect(split.cacheCreationTokens).toBe(0);
  });

  test("B: the three parts always sum back to prompt_tokens", () => {
    for (const url of [CACHED_TURN, OPENROUTER_TURN]) {
      const split = splitPromptTokens(capturedUsage(url));
      expect(split.inputTokens + split.cacheReadTokens + split.cacheCreationTokens).toBe(
        split.promptTokens
      );
    }
  });

  test("C: OpenRouter's cache_write_tokens is the cache-creation counter", () => {
    const usage = capturedUsage(OPENROUTER_TURN);
    // The committed capture reports both counters as 0 — an uncached turn — so
    // this pins the FIELD NAME against that real shape and the arithmetic
    // against a copy of it that carries a write.
    expect(usage.prompt_tokens_details).toHaveProperty("cache_write_tokens");
    const withWrite = {
      ...usage,
      prompt_tokens: 100,
      prompt_tokens_details: { ...usage.prompt_tokens_details, cache_write_tokens: 40 },
    };
    const split = splitPromptTokens(withWrite);
    expect(split.cacheCreationTokens).toBe(40);
    expect(split.inputTokens).toBe(60);
  });

  test("D: a provider that reports no details degrades to all-ordinary-input", () => {
    const split = splitPromptTokens({ prompt_tokens: 1234, completion_tokens: 7 });
    expect(split.inputTokens).toBe(1234);
    expect(split.cacheReadTokens).toBe(0);
    expect(split.cacheCreationTokens).toBe(0);
  });

  test("E: absent, null and nonsense usage never throw and never go negative", () => {
    for (const input of [undefined, null, "", 0, { prompt_tokens: -5 }, { prompt_tokens: "x" }]) {
      const split = splitPromptTokens(input);
      expect(split.promptTokens).toBe(0);
      expect(split.inputTokens).toBe(0);
      expect(split.cacheReadTokens).toBe(0);
      expect(split.cacheCreationTokens).toBe(0);
    }
  });

  test("F: a cached count larger than the prompt is clamped, not trusted", () => {
    // Holds the sum invariant against a provider whose counters disagree.
    const split = splitPromptTokens({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 900 },
    });
    expect(split.cacheReadTokens).toBe(100);
    expect(split.cacheCreationTokens).toBe(0);
    expect(split.inputTokens).toBe(0);
    expect(split.inputTokens + split.cacheReadTokens + split.cacheCreationTokens).toBe(100);
  });
});

describe("onTokenUpdate keeps the FULL context in its first argument", () => {
  test("I: the tracker is told 20379, not the reduced 27", async () => {
    const seen: Array<{ input: number; output: number; detail?: any }> = [];
    const upstream = new Response(readFileSync(CACHED_TURN, "utf8"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    await createStreamingResponseHandler(
      createMockContext(),
      upstream,
      new DefaultAPIFormat("test-model"),
      "test-model",
      null,
      (input, output, detail) => seen.push({ input, output, detail })
    ).text();

    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    // THE rule from the design's money section: passing the reduced wire value
    // here would report a nearly-full conversation as almost empty and disarm
    // auto-compaction. The split rides in the third argument, for cost only.
    expect(last.input).toBe(20379);
    expect(last.detail).toEqual({ cacheReadTokens: 20352, cacheCreationTokens: 0 });
  });
});

describe("openai-sse message_delta carries all three input counters", () => {
  test("G: the cached capture ships 27 / 20352 / 0, summing to the full context", async () => {
    const usage = await closingUsage(CACHED_TURN);
    expect(usage.input_tokens).toBe(27);
    expect(usage.cache_read_input_tokens).toBe(20352);
    expect(usage.cache_creation_input_tokens).toBe(0);
    // The client re-derives the conversation size from exactly this sum, so this
    // assertion is the whole safety argument for shipping a reduced input_tokens.
    expect(
      usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    ).toBe(20379);
  });

  test("J: a fully-cached turn is reported unsplit, so the client's sum stays right", async () => {
    // Reached only when a request repeats one already cached (a retry): the new
    // user message is never in the cached prefix. The client's usage merge
    // DISCARDS a delta `input_tokens: 0` and keeps its message_start seed, which
    // would then be summed with a full-size cache read and roughly double the
    // reported conversation size. Reporting the turn as ordinary input keeps
    // the sum exactly equal to prompt_tokens.
    const wire = readFileSync(CACHED_TURN, "utf8").replace(
      '"cached_tokens":20352',
      '"cached_tokens":20379'
    );
    const upstream = new Response(wire, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await createStreamingResponseHandler(
      createMockContext(),
      upstream,
      new DefaultAPIFormat("test-model"),
      "test-model",
      null
    ).text();
    const usage = out
      .split("\n\n")
      .map((p) =>
        p
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice(6)
      )
      .filter((d): d is string => Boolean(d) && d !== "[DONE]")
      .map((d) => JSON.parse(d))
      .filter((p) => p?.type === "message_delta")
      .pop()?.usage;

    expect(usage.input_tokens).toBe(20379);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(
      usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    ).toBe(20379);
  });

  test("H: all three keys are PRESENT even when two of them are zero", async () => {
    const usage = await closingUsage(OPENROUTER_TURN);
    expect(Object.keys(usage).sort()).toEqual([
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "input_tokens",
      "output_tokens",
    ]);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.input_tokens).toBe(8);
  });
});
