import { describe, expect, it } from "bun:test";

import { encodeToolName, newToolNameBindings } from "../../../adapters/tool-name-utils.js";
import { createStreamingResponseHandler } from "./openai-sse.js";

const ctx: any = {
  body: (stream: any, init: any) => new Response(stream, init),
  json: () => {
    throw new Error("Unexpected no-body error path");
  },
};

const adapter = {
  getToolNameMap: () => new Map([["web_search", "WebSearch"]]),
  processTextContent: (text: string) => ({
    cleanedText: text,
    extractedToolCalls: [],
    wasTransformed: false,
  }),
};

const toolSchemas = [
  {
    name: "Read",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "WebSearch",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

const sseResponse = (frames: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

const dataFrame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

const textFrame = (content: string) =>
  dataFrame({ choices: [{ delta: { content }, finish_reason: null }] });

const finishFrame = (finishReason: "stop" | "tool_calls") =>
  dataFrame({ choices: [{ delta: {}, finish_reason: finishReason }] });

function toolUseStarts(wire: string): any[] {
  const starts: any[] = [];
  for (const frame of wire.split("\n\n")) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine || dataLine === "data: [DONE]") continue;
    try {
      const data = JSON.parse(dataLine.slice(6));
      if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
        starts.push(data.content_block);
      }
    } catch {}
  }
  return starts;
}

async function parseFrames(frames: string[]) {
  const observed: string[] = [];
  const response = createStreamingResponseHandler(
    ctx,
    sseResponse(frames),
    adapter,
    "test-model",
    null,
    undefined,
    toolSchemas,
    adapter.getToolNameMap(),
    undefined,
    { onToolCallObserved: (name) => observed.push(name) }
  );
  const wire = await response.text();

  return { observed, toolUses: toolUseStarts(wire) };
}

describe("openai-sse tool-name recovery", () => {
  it("does not dispatch malformed function-tag prose", async () => {
    const malformed =
      '<function=web_search_query_listOpposed["macos security add-generic-password -X hex password flag"]>';
    const result = await parseFrames([
      textFrame(malformed),
      finishFrame("stop"),
      "data: [DONE]\n\n",
    ]);

    expect(result.toolUses).toEqual([]);
    expect(result.observed).toEqual([]);
  });

  it("does not recover a second call from prose when a structured call exists", async () => {
    const result = await parseFrames([
      textFrame("I will use <function=web_search> for this."),
      dataFrame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_web_search_0",
                  type: "function",
                  function: { name: "web_search", arguments: '{"query":"x"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      finishFrame("tool_calls"),
      "data: [DONE]\n\n",
    ]);

    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe("WebSearch");
    expect(result.observed).toEqual(["WebSearch"]);
  });

  it("recovers an advertised Read call and rejects an unadvertised text call", async () => {
    const recovered = await parseFrames([
      textFrame("<function=Read><parameter=file_path>/x"),
      finishFrame("stop"),
      "data: [DONE]\n\n",
    ]);

    expect(recovered.toolUses).toHaveLength(1);
    expect(recovered.toolUses[0].name).toBe("Read");
    expect(recovered.observed).toEqual(["Read"]);

    const unadvertised = await parseFrames([
      textFrame("<function=Unadvertised><parameter=value>x"),
      finishFrame("stop"),
      "data: [DONE]\n\n",
    ]);
    expect(unadvertised.toolUses).toEqual([]);
    expect(unadvertised.observed).toEqual([]);
  });
});

// ─── Item 7: decoding the encoded name back ─────────────────────────────────
//
// These frames are CONSTRUCTED, as every frame in this file always has been:
// the decode paths below cannot be reached from any capture in the tree (no
// capture carries a >64-char tool name, and none splits `function.name` across
// chunks). Nothing here is a `.sse` fixture, and no capture was invented.

/** A real 65-char MCP name, and what the codec sends in its place. */
const ORIGINAL = "mcp__plugin_browser-use_browser-use__retry_with_browser_use_agent";
const ENCODED = encodeToolName(ORIGINAL, 64, newToolNameBindings());

const longNameAdapter = {
  getToolNameMap: () => new Map([[ENCODED, ORIGINAL]]),
  processTextContent: (text: string) => ({
    cleanedText: text,
    extractedToolCalls: [],
    wasTransformed: false,
  }),
};

const longNameSchemas = [
  {
    name: ORIGINAL,
    input_schema: {
      type: "object",
      properties: { task: { type: "string" } },
      required: ["task"],
    },
  },
];

async function parseWithLongName(frames: string[]) {
  const observed: string[] = [];
  const response = createStreamingResponseHandler(
    ctx,
    sseResponse(frames),
    longNameAdapter,
    "test-model",
    null,
    undefined,
    longNameSchemas,
    longNameAdapter.getToolNameMap(),
    undefined,
    { onToolCallObserved: (name) => observed.push(name) }
  );
  const wire = await response.text();
  return { observed, toolUses: toolUseStarts(wire), argumentJson: inputJson(wire) };
}

/** The `input_json_delta` payload, concatenated — where a tool's arguments land. */
function inputJson(wire: string): string {
  let json = "";
  for (const frame of wire.split("\n\n")) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine || dataLine === "data: [DONE]") continue;
    try {
      const data = JSON.parse(dataLine.slice(6));
      if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta") {
        json += data.delta.partial_json ?? "";
      }
    } catch {}
  }
  return json;
}

describe("openai-sse: the 64-char tool-name codec, decoded", () => {
  it("decodes a name the model returned whole", async () => {
    const result = await parseWithLongName([
      dataFrame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_0",
                  type: "function",
                  function: { name: ENCODED, arguments: '{"task":"x"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      finishFrame("tool_calls"),
      "data: [DONE]\n\n",
    ]);

    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe(ORIGINAL);
    expect(result.observed).toEqual([ORIGINAL]);
  });

  it("decodes a name that arrived in FRAGMENTS across chunks", async () => {
    // The defect: the tool is created from the first fragment, and a prefix of
    // an encoded name decodes to nothing — so the call is dropped with no error
    // anywhere. Decoding must happen against the ACCUMULATED name, and the tool
    // created early must be revised when the rest arrives.
    const head = ENCODED.slice(0, 7);
    const mid = ENCODED.slice(7, 40);
    const tail = ENCODED.slice(40);

    const result = await parseWithLongName([
      dataFrame({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: head } }],
            },
            finish_reason: null,
          },
        ],
      }),
      dataFrame({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: mid } }] }, finish_reason: null },
        ],
      }),
      dataFrame({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: tail } }] }, finish_reason: null },
        ],
      }),
      dataFrame({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"task":"x"}' } }] },
            finish_reason: null,
          },
        ],
      }),
      finishFrame("tool_calls"),
      "data: [DONE]\n\n",
    ]);

    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe(ORIGINAL);
    // The arguments that arrived after the name survived the revision.
    expect(result.argumentJson).toBe('{"task":"x"}');
    expect(result.observed).toEqual([ORIGINAL]);
  });

  it("decodes a call RECOVERED from prose", async () => {
    // The model writes the name it was given — the encoded one — while the
    // recovery allowlist is built from the client's originals. Undecoded, the
    // allowlist drops it and nothing says so.
    const result = await parseWithLongName([
      textFrame(`<function=${ENCODED}><parameter=task>x`),
      finishFrame("stop"),
      "data: [DONE]\n\n",
    ]);

    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe(ORIGINAL);
    expect(result.observed).toEqual([ORIGINAL]);
  });
});
