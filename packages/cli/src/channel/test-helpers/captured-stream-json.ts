import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Test fixtures sourced from the real Claude Code 2.1.239 probe captures.
 *
 * The probe deliberately saved only the first 700/900 bytes of each distinct
 * frame (see the probe scripts beside the samples). Short frames are replayed
 * byte-for-byte. The captured assistant frame is complete through its message,
 * session id, uuid, and timestamp; only the cut-off `request...` suffix is
 * removed before closing the outer object so it is valid NDJSON again.
 */

// TRACKED, deliberately. These captures previously lived in
// `ai-docs/sessions/dev-arch-.../probes`, which `.gitignore:56` excludes — so the
// tests passed on the machine that recorded them and FAILED in CI, which clones
// fresh and has no session directory. CLAUDE.md names this exact trap ("three
// write-ups already died this way"); this was the fourth. A test fixture is
// something meant to outlive the session, so it belongs next to the test.
const PROBE_DIR = resolve(import.meta.dir, "captures");

export const BIDIRECTIONAL_CAPTURE_PATH = resolve(PROBE_DIR, "samples-bidirectional.txt");
export const TOOL_TURN_CAPTURE_PATH = resolve(PROBE_DIR, "samples-tool-turn.txt");

const bidirectionalLines = readFileSync(BIDIRECTIONAL_CAPTURE_PATH, "utf-8")
  .split("\n")
  .filter((line) => line.trim().length > 0);
const toolTurnLines = readFileSync(TOOL_TURN_CAPTURE_PATH, "utf-8")
  .split("\n")
  .filter((line) => line.trim().length > 0);

function requiredLine(lines: readonly string[], marker: string): string {
  const line = lines.find((candidate) => candidate.includes(marker));
  if (!line) throw new Error(`Captured stream-json fixture is missing ${marker}`);
  return line;
}

/** A complete real `system:status` frame, replayed byte-for-byte. */
export const CAPTURED_STATUS_LINE = requiredLine(bidirectionalLines, '"subtype":"status"');

/** A complete real partial-message delta, replayed byte-for-byte. */
export const CAPTURED_DELTA_LINE = requiredLine(bidirectionalLines, '"type":"content_block_delta"');

/** A complete real rate-limit frame, replayed byte-for-byte. */
export const CAPTURED_RATE_LIMIT_LINE = requiredLine(
  bidirectionalLines,
  '"type":"rate_limit_event"'
);

/**
 * The real ALPHA assistant frame with only the probe's truncated suffix
 * removed. The assistant message itself is untouched.
 */
export const CAPTURED_ASSISTANT_FRAME = (() => {
  const prefix = requiredLine(bidirectionalLines, '"type":"assistant"');
  const truncationAt = prefix.lastIndexOf(',"reques');
  if (truncationAt === -1) {
    throw new Error("Captured assistant fixture no longer has the expected probe truncation");
  }
  return JSON.parse(`${prefix.slice(0, truncationAt)}}`) as Record<string, unknown>;
})();

/** Exact prose carried by the captured assistant frame (`ALPHA`). */
export const CAPTURED_ASSISTANT_PROSE = (() => {
  const message = CAPTURED_ASSISTANT_FRAME.message as {
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  const text = message.content?.find((block) => block.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Captured assistant fixture has no text block");
  return text;
})();

/**
 * A minimal projection of the real captured terminal result.
 *
 * The result sample is cut at 900 bytes inside its usage detail. These fields
 * all occur before that cut and are extracted from the capture rather than
 * invented. `type: result` is the discriminator the probe used to select the
 * sample (its property occurs after the cut in Claude Code's serialized order).
 */
export function capturedSuccessResult(result: string, numTurns = 1): Record<string, unknown> {
  const prefix = requiredLine(toolTurnLines, '"is_error":false');
  const parsedBoolean = /"is_error":(true|false)/.exec(prefix)?.[1] === "true";
  const stopReason = /"stop_reason":"([^"]+)"/.exec(prefix)?.[1] ?? null;
  const sessionId = /"session_id":"([^"]+)"/.exec(prefix)?.[1] ?? null;
  const inputTokens = Number(/"input_tokens":(\d+)/.exec(prefix)?.[1] ?? 0);
  const outputTokens = Number(/"output_tokens":(\d+)/.exec(prefix)?.[1] ?? 0);

  return {
    type: "result",
    subtype: "success",
    is_error: parsedBoolean,
    num_turns: numTurns,
    stop_reason: stopReason,
    session_id: sessionId,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    terminal_reason: "completed",
    api_error_status: null,
    result,
  };
}

/** Clone the captured assistant frame, optionally replacing only its text. */
export function capturedAssistantFrame(text = CAPTURED_ASSISTANT_PROSE): Record<string, unknown> {
  const frame = structuredClone(CAPTURED_ASSISTANT_FRAME) as {
    message: { content: Array<{ type?: unknown; text?: unknown }> };
  };
  const block = frame.message.content.find((candidate) => candidate.type === "text");
  if (!block) throw new Error("Captured assistant fixture has no text block");
  block.text = text;
  return frame as Record<string, unknown>;
}
