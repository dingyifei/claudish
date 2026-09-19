/**
 * Every `content_block_start` for a `tool_use` carries `input: {}`.
 *
 * Anthropic's wire opens a tool block with an EMPTY input object which the
 * following `input_json_delta` frames fill in. `openai-sse.ts` omitted the key
 * at all seven of its tool-start sites, so a client saw `input === undefined`
 * until the first delta landed — and on a turn that died in between, a block
 * with no `input` key at all, which is a different shape from an empty one.
 *
 * Asserted over the REAL captures in the tree rather than at the source: the
 * point is what reaches the client, and the tool-start sites are reachable by
 * two different paths (streaming and buffered) that this exercises separately.
 * Nothing here is hand-written SSE.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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

const TOOL_SCHEMAS = [
  {
    name: "Read",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "Bash",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function replayableCaptures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".sse"))
    .filter((f) => {
      const body = readFileSync(join(FIXTURES_DIR, f), "utf-8");
      // OpenAI chat-completions shape AND it actually calls a tool — a capture
      // with no tool call would pass this file vacuously.
      return body.includes('"choices"') && body.includes("tool_calls");
    })
    .sort();
}

async function toolStarts(fixture: string, toolSchemas?: any[]): Promise<any[]> {
  const bytes = new TextEncoder().encode(readFileSync(join(FIXTURES_DIR, fixture), "utf-8"));
  const response = createStreamingResponseHandler(
    {
      body(stream: ReadableStream, init?: any) {
        return new Response(stream, init);
      },
    } as any,
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes);
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

  const starts: any[] = [];
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
        const d = JSON.parse(dataStr);
        if (d?.type === "content_block_start" && d.content_block?.type === "tool_use") {
          starts.push(d.content_block);
        }
      } catch {}
    }
  }
  return starts;
}

describe("openai-sse: a tool_use content_block_start carries input: {}", () => {
  const captures = replayableCaptures();

  test("at least one real capture makes a tool call", () => {
    expect(captures.length).toBeGreaterThan(0);
  });

  for (const fixture of captures) {
    for (const mode of ["no schemas (streaming path)", "schemas (buffered path)"] as const) {
      test(`${fixture} — ${mode}`, async () => {
        const starts = await toolStarts(
          fixture,
          mode === "schemas (buffered path)" ? TOOL_SCHEMAS : undefined
        );
        expect(starts.length).toBeGreaterThan(0);
        for (const block of starts) {
          expect(block).toHaveProperty("input");
          expect(block.input).toEqual({});
        }
      });
    }
  }
});
