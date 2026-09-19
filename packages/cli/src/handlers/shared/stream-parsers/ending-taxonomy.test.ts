/**
 * Item 4 — how a turn ENDED, asserted against REAL captures that have been CUT.
 *
 * `finish_reason` is the only completion signal. Neither the `[DONE]` sentinel
 * nor a final usage object counts: both are transport punctuation a proxy, a
 * load balancer or a truncated body can produce without the model ever having
 * finished. A turn that produced content and then simply stopped used to be
 * reported as `end_turn` — "the turn finished, run the tool" — which is how a
 * client comes to execute a truncated tool call.
 *
 * ## Provenance: every byte here came from a real provider response
 *
 * The new rows of the taxonomy need a stream that ENDS without a finish_reason,
 * which is what a dead socket produces and what no complete capture contains. So
 * the captures are REPLAYED WITH RECORDS REMOVED — a prefix cut, or in one case
 * the deletion of the single finish_reason record from the middle. Nothing is
 * added, reordered or rewritten, and no `.sse` fixture was written: inventing
 * one is what the caller's real-captures-only rule forbids, and truncation needs
 * no invention.
 *
 * This file replaces `probes/ending-taxonomy.ts` in the (gitignored) session
 * directory, which was item 4's only gate and therefore no gate at all —
 * reverting the classification left the committed suite entirely green.
 *
 * ## What each ending promises
 *
 * - `success` — the provider said how it finished, or produced nothing.
 * - `silent-truncation` — no finish_reason, content, no tool in flight. Reported
 *   as `max_tokens`, which is Anthropic's own word for a cut-off turn. NOT an
 *   error: the partial prose is harmless and visible, and an error would discard
 *   text the user can read.
 * - `failure` — an SSE `error` event, the one ending Claude Code honours by
 *   discarding a partial `tool_use` and retrying. No NEW tool block and no
 *   COMPLETED tool call: the buffered flush is skipped and recovered calls are
 *   suppressed. It cannot recall a non-buffered block already on the wire, and
 *   that partial is exactly what the client-side measurement covers.
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
  {
    name: "Edit",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
];

/** The capture's `data:` records, in order, exactly as captured. */
function records(file: string): string[] {
  return readFileSync(join(FIXTURES_DIR, file), "utf-8")
    .split("\n\n")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

const body = (recs: string[]) => `${recs.join("\n\n")}\n\n`;

/** A dead socket: the first `keep` records of a real capture and nothing after. */
function cut(file: string, keep: number): string {
  return body(records(file).slice(0, keep));
}

function toResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

async function replay(text: string, toolSchemas?: any[]) {
  const response = createStreamingResponseHandler(
    { body: (s: ReadableStream, i?: any) => new Response(s, i) } as any,
    toResponse(text),
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

  return {
    stopReason: events.find((e) => e.type === "message_delta")?.delta?.stop_reason ?? null,
    error: events.find((e) => e.type === "error")?.error?.message ?? null,
    messageStop: events.some((e) => e.type === "message_stop"),
    toolBlocks: events
      .filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use")
      .map((e) => e.content_block.name),
    toolArgDeltas: events.filter(
      (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
    ).length,
    text: events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join(""),
  };
}

// ─── The premise: these cuts really are cuts ────────────────────────────────

test("the captures are the length this file assumes", () => {
  // A capture that grew or shrank would silently move every cut below onto a
  // different record boundary, and most of them would still pass.
  expect(records("SEED-openai-tool-call.sse").length).toBe(6);
  expect(records("SEED-openai-text-only.sse").length).toBe(6);
  // …and the last record of each really is the sentinel we re-append.
  expect(records("SEED-openai-tool-call.sse")[5]).toBe("data: [DONE]");
});

// ─── The unchanged rows — a provider that said how it finished ──────────────

describe("a complete capture is unaffected", () => {
  test("finish_reason=tool_calls → tool_use, no error", async () => {
    const r = await replay(cut("SEED-openai-tool-call.sse", 99), SCHEMAS);
    expect(r.error).toBeNull();
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolBlocks).toEqual(["Read"]);
  });

  test("finish_reason=stop → end_turn, no error", async () => {
    const r = await replay(cut("SEED-openai-text-only.sse", 99));
    expect(r.error).toBeNull();
    expect(r.stopReason).toBe("end_turn");
    expect(r.text).toBe("Hello, I'm a test model.");
  });

  test("finish_reason=length → max_tokens, no error, with content", async () => {
    const r = await replay(cut("gemini-3.1-pro-or-maxtokens-truncated.sse", 999));
    expect(r.error).toBeNull();
    expect(r.stopReason).toBe("max_tokens");
  });

  test("finish_reason=length → max_tokens, no error, with NO content", async () => {
    // Item 12 must not fire here: emptiness is meaningful on a truncation, and
    // this is a real capture of exactly that.
    const r = await replay(cut("gemini-3.1-pro-or-maxtokens-empty.sse", 999));
    expect(r.error).toBeNull();
    expect(r.stopReason).toBe("max_tokens");
  });
});

// ─── The new rows — a stream that just stopped ──────────────────────────────

describe("no finish_reason, a tool in flight → failure", () => {
  test("cut mid tool-arguments, BUFFERED: no tool block is emitted at all", async () => {
    const r = await replay(cut("SEED-openai-tool-call.sse", 4), SCHEMAS);
    expect(r.error).toContain("no finish_reason");
    expect(r.stopReason).toBeNull();
    // The buffered flush is skipped entirely, so nothing parseable reaches the
    // client. Before item 4 this shipped a COMPLETE tool call and then an error.
    expect(r.toolBlocks).toEqual([]);
  });

  test("cut mid tool-arguments, STREAMING: the partial block has no completion", async () => {
    const r = await replay(cut("SEED-openai-tool-call.sse", 4));
    expect(r.error).toContain("no finish_reason");
    expect(r.stopReason).toBeNull();
    // What finalization can promise is bounded here and stated plainly: the
    // `content_block_start` went out before a single argument byte existed and
    // cannot be recalled. It carries one delta and no completion, which is
    // precisely the case the client-side measurement covers.
    expect(r.toolBlocks).toEqual(["Read"]);
    expect(r.toolArgDeltas).toBe(1);
  });

  test("cut after the tool NAME only", async () => {
    const r = await replay(cut("SEED-openai-tool-call.sse", 3), SCHEMAS);
    expect(r.error).toContain("no finish_reason");
    expect(r.toolBlocks).toEqual([]);
  });
});

describe("neither [DONE] nor a usage object is a completion signal", () => {
  test("cut mid tool-arguments but WITH the capture's own [DONE] still fails", async () => {
    const recs = records("SEED-openai-tool-call.sse");
    // The capture's own sentinel, re-appended verbatim — the transport
    // punctuation a proxy emits after the model has already gone away.
    const r = await replay(body([...recs.slice(0, 4), recs[5]]), SCHEMAS);
    expect(r.error).toContain("no finish_reason");
    expect(r.toolBlocks).toEqual([]);
  });

  test("a real capture with ONLY its finish_reason record deleted still fails", async () => {
    // grok-4.6: 51 records. #49 carries `finish_reason: "tool_calls"`, #50 is a
    // standalone usage object and #51 is `[DONE]`. Deleting #49 alone leaves a
    // stream that produced a complete tool call and then received both pieces of
    // punctuation — and it must STILL be a failure, because neither of them is
    // the model saying it finished.
    const recs = records("grok-4.6-openai-edit-empty-new-string.sse");
    expect(recs.length).toBe(51);
    expect(recs[48]).toContain('"finish_reason":"tool_calls"');
    expect(recs[49]).toContain('"usage"');
    expect(recs[50]).toBe("data: [DONE]");

    const r = await replay(body([...recs.slice(0, 48), recs[49], recs[50]]), SCHEMAS);
    expect(r.error).toContain("no finish_reason");
    expect(r.stopReason).toBeNull();
  });
});

describe("no finish_reason, NO tool in flight", () => {
  test("content but no tool → max_tokens, and the text survives", async () => {
    // A deliberate divergence from FCC, which fails outright here. The partial
    // prose is harmless and VISIBLE; an error would discard text the user can
    // read. This is what bounds the stricter rule's false-positive cost to
    // tool-bearing turns.
    const r = await replay(cut("SEED-openai-tool-call.sse", 2), SCHEMAS);
    expect(r.error).toBeNull();
    expect(r.stopReason).toBe("max_tokens");
    expect(r.text).toBe("Let me read that file.");
    expect(r.messageStop).toBe(true);
  });

  test("nothing produced at all → end_turn, no error", async () => {
    // Emptiness with no content is not a truncation — there is nothing to have
    // been cut off. Item 12 supplies the empty text block here.
    const r = await replay(cut("SEED-openai-text-only.sse", 1));
    expect(r.error).toBeNull();
    expect(r.stopReason).toBe("end_turn");
    expect(r.messageStop).toBe(true);
  });
});
