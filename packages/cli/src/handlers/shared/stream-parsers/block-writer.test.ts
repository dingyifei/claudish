/**
 * The block writer's own contract: an index is spent ONCE.
 *
 * Anthropic's wire identifies a content block by its index for the whole
 * message. Re-opening an index that already had its `content_block_stop` gives
 * the client two different blocks wearing one name — two `content_block_start`
 * frames, two full lifecycles — and makes the tool-observation hook in
 * `openai-sse.ts` count one call twice, against its own comment ("exactly one
 * `content_block_start` is emitted per tool call").
 *
 * THE PRODUCTION CALLER that reaches it: when a tool's argument fragments lose
 * the open block mid-stream (OpenAI's wire lets `tool_calls[0]` and
 * `tool_calls[1]` interleave; Anthropic's does not), `openai-sse.ts` degrades
 * that tool to the buffered path — `started = false; ref = null` — while KEEPING
 * its already-spent `blockIndex`. Finalization then asks for that index again.
 * The sequence below is that exact call order, taken from the two sites rather
 * than imagined.
 *
 * ## Provenance of the inputs
 *
 * These are calls on this tree's own function, not a provider's bytes. No `.sse`
 * fixture was invented to reach the degrade path: no capture in
 * `test-fixtures/sse-responses/` interleaves two unbuffered tool calls, and
 * writing one that did would be inventing the capture. The capture-driven gate
 * is `block-nesting.test.ts`, whose `nestingViolations` already reports
 * `index=N started twice` — so the day a real capture with interleaved calls
 * lands, it is covered there for free.
 *
 * §A.3: the writer must NEVER throw. Every case below asserts it corrected the
 * state and carried on.
 */

import { describe, expect, test } from "bun:test";
import { createBlockWriter } from "./block-writer.js";

interface Frame {
  event: string;
  data: any;
}

function recordingWriter() {
  const frames: Frame[] = [];
  const writer = createBlockWriter((event, data) => frames.push({ event, data }));
  return { writer, frames };
}

/** The same rules `block-nesting.test.ts` applies to a replayed capture. */
function nestingViolations(frames: Frame[]): string[] {
  const problems: string[] = [];
  let open: number | null = null;
  const started = new Set<number>();
  const stopped = new Set<number>();

  frames.forEach(({ event, data }, i) => {
    if (event === "content_block_start") {
      if (open !== null)
        problems.push(`frame ${i}: start index=${data.index} while ${open} is open`);
      if (started.has(data.index)) problems.push(`frame ${i}: index=${data.index} started twice`);
      started.add(data.index);
      open = data.index;
    } else if (event === "content_block_delta") {
      if (open !== data.index) {
        problems.push(`frame ${i}: delta index=${data.index} but open is ${open ?? "none"}`);
      }
    } else if (event === "content_block_stop") {
      if (open !== data.index) {
        problems.push(`frame ${i}: stop index=${data.index} but open is ${open ?? "none"}`);
      }
      if (stopped.has(data.index)) problems.push(`frame ${i}: index=${data.index} stopped twice`);
      stopped.add(data.index);
      open = null;
    }
  });
  if (open !== null) problems.push(`ended with index=${open} still open`);
  return problems;
}

const startIndices = (frames: Frame[]) =>
  frames.filter((f) => f.event === "content_block_start").map((f) => f.data.index);

describe("an index is spent once", () => {
  test("openTool refuses a stopped index and re-indexes instead", () => {
    const { writer, frames } = recordingWriter();

    // Tool 0 opens and streams a partial argument fragment.
    const t0 = writer.openTool({ id: "call_0", name: "Read" });
    expect(t0.index).toBe(0);
    expect(writer.append(t0, '{"file')).toBe(true);

    // Tool 1's fragments interleave. Opening it closes tool 0's block — index 0
    // is now spent.
    const t1 = writer.openTool({ id: "call_1", name: "Read" });
    expect(writer.append(t1, '{"file_path":"b"}')).toBe(true);

    // The rest of tool 0's arguments arrive. Its block is gone, so the append
    // is refused and the caller degrades it to the buffered path — keeping the
    // index it already spent.
    expect(writer.append(t0, '_path":"a"}')).toBe(false);

    // Finalization asks for that spent index back. It must NOT be honoured.
    const reopened = writer.openTool({ id: "call_0", name: "Read", index: t0.index });
    expect(reopened.index).not.toBe(t0.index);
    writer.append(reopened, '{"file_path":"a"}');
    writer.close(reopened);

    expect(nestingViolations(frames)).toEqual([]);
    expect(startIndices(frames)).toEqual([0, 1, 2]);
  });

  test("openText refuses a stopped index the same way", () => {
    // The validation-failure path spends a buffered tool's reserved index on a
    // `⚠️` text block. If that index has already carried a block, the warning
    // must not reuse it.
    const { writer, frames } = recordingWriter();

    const tool = writer.openTool({ id: "call_0", name: "Read" });
    writer.append(tool, "{}");
    writer.closeCurrent();

    const text = writer.openText({ index: tool.index });
    expect(text.index).not.toBe(tool.index);
    writer.append(text, "⚠️");
    writer.close(text);

    expect(nestingViolations(frames)).toEqual([]);
    expect(startIndices(frames)).toEqual([0, 1]);
  });

  test("the writer corrects and continues — it never throws", () => {
    const { writer } = recordingWriter();
    const tool = writer.openTool({ id: "call_0", name: "Read" });
    writer.closeCurrent();

    expect(() => writer.openTool({ id: "call_0", name: "Read", index: tool.index })).not.toThrow();
    expect(() => writer.openText({ index: tool.index })).not.toThrow();
    // …and the superseded ref is still safe to close, as it always was.
    expect(() => writer.close(tool)).not.toThrow();
  });
});

describe("a reserved index that was never opened is still honoured", () => {
  test("reserve() then openTool(index) spends exactly the reserved slot", () => {
    // The non-regression half: a buffered tool reserves its index when its name
    // arrives and emits at finish_reason time. Nothing was stopped there, so the
    // reservation must be kept — otherwise the fix above silently re-orders
    // every buffered tool call.
    const { writer, frames } = recordingWriter();

    const reserved = writer.reserve();
    expect(reserved).toBe(0);

    const text = writer.openText();
    expect(text.index).toBe(1);
    writer.append(text, "Let me read that file.");

    const tool = writer.openTool({ id: "call_0", name: "Read", index: reserved });
    expect(tool.index).toBe(reserved);
    writer.append(tool, '{"file_path":"a"}');
    writer.close(tool);

    expect(nestingViolations(frames)).toEqual([]);
    expect(startIndices(frames)).toEqual([1, 0]);
  });
});

describe("exactly one block is open at a time — item 5's invariant", () => {
  /**
   * `ccca029`'s behaviour change, pinned at the altitude where it is reachable.
   *
   * The defect it fixed: a `reasoning_content` chunk arriving AFTER text opened
   * a `thinking` block without closing the open text block, leaving two open and
   * hanging the client's rendering. `block-nesting.test.ts` cannot see it — it
   * replays real captures, and no capture in the tree emits reasoning after
   * content (verified: every OpenAI-shaped capture is R…T…C, never T…R). That
   * gap is recorded in the session's `tests/test-plan.md` rather than closed
   * with an invented fixture. These assertions close the half that CAN be
   * reached honestly: the writer's own transition table.
   */
  test("openThinking closes an open TEXT block first", () => {
    const { writer, frames } = recordingWriter();

    const text = writer.openText();
    writer.append(text, "answer");
    const thinking = writer.openThinking();
    writer.append(thinking, "late thought");
    writer.closeCurrent();

    expect(nestingViolations(frames)).toEqual([]);
    expect(frames.map((f) => `${f.event}@${f.data.index}`)).toEqual([
      "content_block_start@0",
      "content_block_delta@0",
      "content_block_stop@0",
      "content_block_start@1",
      "content_block_delta@1",
      "content_block_stop@1",
    ]);
  });

  test("openText closes an open THINKING block first", () => {
    const { writer, frames } = recordingWriter();

    const thinking = writer.openThinking();
    writer.append(thinking, "thought");
    const text = writer.openText();
    writer.append(text, "answer");
    writer.closeCurrent();

    expect(nestingViolations(frames)).toEqual([]);
    expect(startIndices(frames)).toEqual([0, 1]);
  });

  test("openTool closes whatever was open, of either kind", () => {
    for (const open of ["text", "thinking"] as const) {
      const { writer, frames } = recordingWriter();
      const first = open === "text" ? writer.openText() : writer.openThinking();
      writer.append(first, "x");
      const tool = writer.openTool({ id: "call_0", name: "Read" });
      writer.append(tool, "{}");
      writer.close(tool);
      expect(nestingViolations(frames)).toEqual([]);
    }
  });

  test("re-opening the SAME kind reuses the open block rather than nesting", () => {
    // Text and thinking reuse; a tool never does, because two `openTool` calls
    // are two calls and the repair path depends on that.
    const { writer, frames } = recordingWriter();

    expect(writer.openText().index).toBe(writer.openText().index);
    expect(writer.openThinking().index).toBe(writer.openThinking().index);
    const a = writer.openTool({ id: "call_0", name: "Read" });
    const b = writer.openTool({ id: "call_1", name: "Read" });
    expect(b.index).not.toBe(a.index);
    writer.closeCurrent();

    expect(nestingViolations(frames)).toEqual([]);
    expect(startIndices(frames)).toEqual([0, 1, 2, 3]);
  });
});
