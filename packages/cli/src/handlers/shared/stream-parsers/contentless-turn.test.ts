/**
 * Item 12 — a turn that ends NORMALLY always carries at least one content block.
 *
 * `stop_reason: "end_turn"` with an empty `content` array is not a shape
 * Anthropic's API produces. A client that indexes the last block, or simply
 * renders the turn, gets a success that delivered nothing and no diagnostic.
 * `openai-sse.ts` `finalize()` therefore emits ONE empty text block in exactly
 * that case.
 *
 * ## The gap this closes
 *
 * The item shipped with its NON-firing half covered (the `max_tokens` capture
 * must not be papered over) and its POSITIVE half declared untested: across
 * eight live runs no model produced a `stop`-terminated turn with no content at
 * all, which is unsurprising — it is a provider malfunction, not a behaviour you
 * can ask for.
 *
 * ## Provenance
 *
 * No `.sse` fixture was written. The contentless streams here are real captures
 * REPLAYED WITH RECORDS REMOVED — the same deletion-only method
 * `ending-taxonomy.test.ts` uses for a dead socket, and for the same reason: a
 * turn with nothing in it is a capture with its content records missing, which
 * needs no invention. Nothing is added, reordered or rewritten.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultAPIFormat } from "../../../adapters/base-api-format.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "test-fixtures",
  "sse-responses"
);

const SCHEMAS = [
  {
    name: "Read",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
];

/** The capture's records, in order, exactly as captured. */
function records(file: string): string[] {
  return readFileSync(join(FIXTURES_DIR, file), "utf-8")
    .split("\n\n")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

const body = (recs: string[]) => `${recs.join("\n\n")}\n\n`;

/** A real capture with the records at `drop` deleted — nothing else changed. */
function without(file: string, drop: number[]): string {
  return body(records(file).filter((_, i) => !drop.includes(i)));
}

async function replay(text: string, toolSchemas?: any[]) {
  const response = createStreamingResponseHandler(
    { body: (s: ReadableStream, i?: any) => new Response(s, i) } as any,
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ),
    new DefaultAPIFormat("test-model") as any,
    "test-model",
    null,
    undefined,
    toolSchemas
  );

  const events: any[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      let dataStr = "";
      for (const line of part.split("\n").filter((l) => l.trim())) {
        if (line.startsWith("data: ")) dataStr += line.slice(6);
      }
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        events.push(JSON.parse(dataStr));
      } catch {}
    }
  }

  const starts = events.filter((e) => e.type === "content_block_start");
  return {
    stopReason: events.find((e) => e.type === "message_delta")?.delta?.stop_reason ?? null,
    messageStop: events.some((e) => e.type === "message_stop"),
    blockKinds: starts.map((e) => e.content_block?.type),
    blockStarts: starts.length,
    blockStops: events.filter((e) => e.type === "content_block_stop").length,
    text: events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join(""),
  };
}

describe("the premise: the captures are the length this file assumes", () => {
  test("a record that moved would slide every deletion below onto another boundary", () => {
    expect(records("SEED-openai-text-only.sse").length).toBe(6);
    expect(records("SEED-openai-tool-call.sse").length).toBe(6);
    expect(records("gemini-3.1-pro-or-maxtokens-empty.sse").length).toBe(13);
  });
});

describe("item 12 FIRES: end_turn with nothing produced", () => {
  test("a stop-terminated turn whose content records are gone gets one empty text block", async () => {
    // Records 1-3 are the three `delta.content` chunks. What remains is the
    // capture's own role-only opener, its own `finish_reason: "stop"` record
    // and its own `[DONE]` — a provider that said it finished and sent nothing.
    const r = await replay(without("SEED-openai-text-only.sse", [1, 2, 3]));
    expect(r.stopReason).toBe("end_turn");
    expect(r.blockKinds).toEqual(["text"]);
    expect(r.blockStarts).toBe(1);
    expect(r.blockStops).toBe(1);
    // EMPTY, not placeholder prose: prose would enter the conversation history
    // as the assistant's words and be replayed forever.
    expect(r.text).toBe("");
    expect(r.messageStop).toBe(true);
  });

  test("a turn that ends with no finish_reason and no content gets the same block", async () => {
    // Only the role-only opener survives: nothing was produced, so this is not a
    // truncation — there is nothing to have been cut off.
    const r = await replay(body(records("SEED-openai-text-only.sse").slice(0, 1)));
    expect(r.stopReason).toBe("end_turn");
    expect(r.blockKinds).toEqual(["text"]);
    expect(r.text).toBe("");
  });
});

describe("item 12 does NOT fire where emptiness is meaningful", () => {
  test("a complete turn keeps its one real text block and gains nothing", async () => {
    const r = await replay(body(records("SEED-openai-text-only.sse")));
    expect(r.stopReason).toBe("end_turn");
    expect(r.blockKinds).toEqual(["text"]);
    expect(r.text).toBe("Hello, I'm a test model.");
  });

  test("a contentless max_tokens turn stays contentless", async () => {
    // A real capture of reasoning consuming the entire budget. The emptiness IS
    // the answer here and must not be papered over.
    const r = await replay(body(records("gemini-3.1-pro-or-maxtokens-empty.sse")));
    expect(r.stopReason).toBe("max_tokens");
    expect(r.blockKinds).not.toContain("text");
  });

  test("a tool-only turn gains no empty text block", async () => {
    // Record 1 is this capture's only prose. With it deleted the turn emits a
    // tool block and nothing else — a tool block IS content, so the guard must
    // stay silent.
    const r = await replay(without("SEED-openai-tool-call.sse", [1]), SCHEMAS);
    expect(r.stopReason).toBe("tool_use");
    expect(r.blockKinds).toEqual(["tool_use"]);
  });

  test("a turn that spoke AND called a tool keeps exactly its own two blocks", async () => {
    const r = await replay(body(records("SEED-openai-tool-call.sse")), SCHEMAS);
    expect(r.stopReason).toBe("tool_use");
    expect(r.blockKinds).toEqual(["text", "tool_use"]);
    expect(r.text).toBe("Let me read that file.");
  });
});
