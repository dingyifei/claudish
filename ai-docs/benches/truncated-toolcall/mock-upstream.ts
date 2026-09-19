// Wire shape: gpt-5.6-sol-responses-turn1.sse; only the interrupted call is emitted.
const response = {
  id: "resp_mock_truncation",
  object: "response",
  created_at: 1784050286,
  status: "in_progress",
  background: false,
  completed_at: null,
  error: null,
  incomplete_details: null,
  model: "gpt-5.6-sol",
  output: [],
  parallel_tool_calls: true,
  usage: null,
  metadata: {},
};
const itemId = "fc_mock_truncation";
// Keep the literal backslash-n: this is a prefix of JSON, not a raw newline in a JSON string.
const delta = String.raw`{"file_path":"/tmp/mock-truncation-probe.txt","content":"line one\nline two`;
const events = [
  { type: "response.created", response, sequence_number: 0 },
  { type: "response.in_progress", response, sequence_number: 1 },
  {
    type: "response.output_item.added",
    item: {
      id: itemId,
      type: "function_call",
      status: "in_progress",
      arguments: "",
      call_id: "call_mock_truncation",
      name: "Write",
    },
    output_index: 0,
    sequence_number: 2,
  },
  {
    type: "response.function_call_arguments.delta",
    delta,
    item_id: itemId,
    obfuscation: "m",
    output_index: 0,
    sequence_number: 3,
  },
];
// A COMPLETE, well-formed turn. Served from the 2nd request onward so a client
// that correctly discards the truncated turn and retries can actually finish.
// v1 of this mock failed EVERY request, which punished correct behaviour: the
// fixed build retried into a wall until the harness killed it, and the buggy
// build died on the same timeout. Both runs errored identically, so the
// experiment discriminated nothing.
const okMessageId = "msg_mock_ok";
const okEvents = [
  { type: "response.created", response, sequence_number: 0 },
  { type: "response.in_progress", response, sequence_number: 1 },
  {
    type: "response.output_item.added",
    item: { id: okMessageId, type: "message", status: "in_progress", content: [], role: "assistant" },
    output_index: 0,
    sequence_number: 2,
  },
  {
    type: "response.content_part.added",
    content_index: 0,
    item_id: okMessageId,
    output_index: 0,
    part: { type: "output_text", annotations: [], logprobs: [], text: "" },
    sequence_number: 3,
  },
  {
    type: "response.output_text.delta",
    content_index: 0,
    delta: "MOCK_RETRY_OK",
    item_id: okMessageId,
    logprobs: [],
    output_index: 0,
    sequence_number: 4,
  },
  {
    type: "response.output_text.done",
    content_index: 0,
    text: "MOCK_RETRY_OK",
    item_id: okMessageId,
    output_index: 0,
    sequence_number: 5,
  },
  {
    type: "response.content_part.done",
    content_index: 0,
    item_id: okMessageId,
    output_index: 0,
    part: { type: "output_text", annotations: [], logprobs: [], text: "MOCK_RETRY_OK" },
    sequence_number: 6,
  },
  {
    type: "response.output_item.done",
    item: {
      id: okMessageId,
      type: "message",
      status: "completed",
      content: [{ type: "output_text", annotations: [], logprobs: [], text: "MOCK_RETRY_OK" }],
      role: "assistant",
    },
    output_index: 0,
    sequence_number: 7,
  },
  {
    type: "response.completed",
    response: { ...response, status: "completed" },
    sequence_number: 8,
  },
];

// Diagnostics. Every request is counted and appended to MOCK_LOG so the run can
// be read back afterwards: how many attempts the client made, and which of them
// got the truncated turn.
const LOG_PATH = process.env.MOCK_LOG ?? "/tmp/mock-upstream.log";
let requestCount = 0;
// Only the FIRST main-turn request is truncated; its retry must be able to win.
let truncatedMainTurn = false;
function note(line: string) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  process.stderr.write(stamped);
  try {
    require("node:fs").appendFileSync(LOG_PATH, stamped);
  } catch {}
}

const encoder = new TextEncoder();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8899),
  async fetch(req) {
    requestCount += 1;
    const attempt = requestCount;

    // Target the MAIN conversation turn, not "any first request".
    //
    // Claude Code fires a session-title request CONCURRENTLY with the real turn.
    // Truncating "request #1" hit the title generator instead: the main turn got
    // the clean response 26ms later and answered normally, which looks exactly
    // like a passing test. Only the per-request log exposed it — #2 arrived long
    // before the truncated stream had finished emitting, so it could not have
    // been a retry of #1.
    //
    // MOCK_TARGET is a marker from the user's prompt. A request whose body
    // carries it IS the main turn. Everything else gets a clean response.
    // The marker alone is NOT enough: Claude Code hands the SAME prompt text to
    // its title generator, so that request matches too. Measured on this mock,
    // the two are an order of magnitude apart and never overlap — the main turn
    // carries the full system prompt and tool schemas (~88 KB) while the title
    // request is ~3.7 KB. Requiring both the marker and the size picks the real
    // turn deterministically, instead of whichever request happens to land first.
    const target = process.env.MOCK_TARGET ?? "notes.txt";
    const minMainTurnBytes = Number(process.env.MOCK_MIN_BYTES ?? 20000);
    let requestBody = "";
    try {
      requestBody = await req.text();
    } catch {}
    const isMainTurn = requestBody.includes(target) && requestBody.length >= minMainTurnBytes;
    const truncate = isMainTurn && !truncatedMainTurn;
    if (truncate) truncatedMainTurn = true;
    note(
      `request #${attempt} ${req.method} ${new URL(req.url).pathname} ` +
        `mainTurn=${isMainTurn} bytes=${requestBody.length} -> ${truncate ? "TRUNCATED+RESET" : "COMPLETE"}`
    );

    if (!truncate) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of okEvents) {
            controller.enqueue(
              encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            );
          }
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = () => {
          const event = events[index++];
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          // Let Bun flush each frame and, especially, the argument delta before aborting.
          timer = setTimeout(() => {
            if (index < events.length) emit();
            else {
              note(`request #${attempt} killing socket after ${events.length} frames`);
              controller.error(new Error("socket died"));
            }
          }, 250);
        };
        emit();
      },
      cancel() {
        clearTimeout(timer);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
note(`Mock upstream listening on ${server.url} (log: ${LOG_PATH})`);
