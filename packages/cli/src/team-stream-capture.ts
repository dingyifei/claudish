/**
 * Recovers a child's FULL answer from a `--output-format stream-json` stream.
 *
 * ## Why this exists
 *
 * `claude -p` prints ONLY the final assistant message. A child that answers and
 * then takes one more turn — a background `Task` completing, any late
 * notification prompting an acknowledgement — has its real answer REPLACED on
 * stdout by that epilogue. Measured on a real `team` run: 7,743 output tokens
 * generated, 250 bytes captured, exit 0, reported "succeeded".
 *
 * The data survives upstream. Captured live from `claude -p --output-format
 * stream-json --verbose` against the minimal repro prompt ("say ALPHA, run a
 * bash command, say OMEGA"):
 *
 *   assistant → thinking
 *   assistant → text        "ALPHA_MARKER"      <- the answer
 *   assistant → tool_use    (Bash)
 *   user      → tool_result
 *   assistant → thinking
 *   assistant → text        "OMEGA_MARKER"      <- the epilogue
 *   result    → .result =   "OMEGA_MARKER"      <- what print mode prints
 *
 * So the loss is purely a choice of output format, and recovery is a matter of
 * reading the events print mode discards.
 *
 * ## What it keeps, and why all of it
 *
 * Every `text` block from every `assistant` event, concatenated in order. The
 * alternative — keep only the last SUBSTANTIAL message — needs a definition of
 * "substantial", i.e. a byte threshold, which is the exact instrument this
 * codebase already established does not work: `DEFAULT_MIN_OUTPUT_BYTES` is 0
 * because a 200-byte default recorded two correct short answers (141 B, 96 B)
 * as EMPTY. Concatenation has a real cost — intermediate "let me read that
 * file" chatter lands in the response file — but it is bounded and legible,
 * whereas a wrong "substantial" verdict silently discards the answer again.
 *
 * `thinking` blocks are dropped: reasoning is not the answer. `tool_use` and
 * `tool_result` are dropped: they are the child's work, not its report.
 *
 * ## Degradation is the safety property
 *
 * Only a line that is BOTH valid JSON AND carries a recognised stream-json
 * `type` is treated as an event. Everything else — plain prose, a JSON shape
 * from some other protocol, a future event vocabulary we do not know — is
 * passed through VERBATIM.
 *
 * The rule is per-line and never latches, deliberately. Sniffing the format
 * once from the first line is cheaper but fails catastrophically in one
 * direction: a single unexpected banner ahead of the stream would silently
 * disable recovery for the whole run and quietly restore the original bug.
 * Under the per-line rule the worst case is raw JSON in a response file — ugly,
 * and visibly so — instead of a lost answer.
 */

/** Bounded window of recovered prose kept for the `is_error` containment test. */
const DEDUPE_TAIL_LIMIT = 4096;

/**
 * The `type` values a stream-json event can carry, captured live from
 * `claude -p --output-format stream-json --verbose`. A JSON line whose type is
 * absent or outside this set is not our protocol and is passed through rather
 * than dropped — see the degradation note in the module header.
 */
export const STREAM_JSON_EVENT_TYPES: ReadonlySet<string> = new Set([
  "system",
  "assistant",
  "user",
  "result",
  // Real protocol event, and its ABSENCE here was a bug: an unrecognised type
  // falls to `passthrough()` (line ~183), so every `rate_limit_event` frame was
  // emitted into the captured answer as prose. Measured 2026-08-22 — a two-byte
  // reply ("OK") was recorded as 191 B of "OK\n{\"type\":\"rate_limit_event\"…}",
  // which corrupts `outputSize` and silently defeats `min_output_bytes`.
  // Enumerated from real `--output-format stream-json` output; the full observed
  // vocabulary is system / assistant / rate_limit_event / result (+ user).
  "rate_limit_event",
]);

/*
 * TWO CONSUMERS READ THIS SET WITH DIFFERENT MEANINGS — check both before editing.
 *
 *   - HERE (`write()` below): membership means "this is our protocol, handle it
 *     structurally". A member that is not `assistant` yields no text, i.e. it is
 *     DROPPED. A non-member is passed through VERBATIM.
 *   - `channel/stream-json-reducer.ts` `reachesAnswer()`: membership means the
 *     opposite direction — "safe to HAND to the capture". A non-member is
 *     withheld from it.
 *
 * So adding a type here drops it in the team path and forwards it in the channel
 * path, and both are only correct because the two work together. `rate_limit_event`
 * is the worked example: the channel gate already withheld it (its comment records
 * the same measurement), which is why the channel path was accidentally fine while
 * the team path stayed broken — a fix in one consumer left the shared source wrong.
 */

export interface AssistantTextCapture {
  /**
   * Feed raw child stdout. Returns the recovered prose produced by this chunk
   * (often ""), so the caller can stream it straight to disk without ever
   * holding the whole answer in memory.
   */
  write(chunk: string): string;
  /** Flush any trailing partial line. Returns the final recovered prose. */
  end(): string;
}

interface AssistantContentBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * Pull the text blocks out of one parsed stream-json event.
 *
 * Returns [] for every event type that is not assistant text, which is most of
 * them (`system`, `user`, `result`) — the caller decides what to do with those.
 */
function extractAssistantText(event: Record<string, unknown>): string[] {
  if (event.type !== "assistant") return [];

  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;

  // Defensive: the observed shape is an array of blocks, but a bare string is a
  // plausible variant and costs one branch to survive.
  if (typeof content === "string") {
    return content.length > 0 ? [content] : [];
  }
  if (!Array.isArray(content)) return [];

  const out: string[] = [];
  for (const raw of content) {
    const block = raw as AssistantContentBlock;
    if (block?.type !== "text") continue;
    if (typeof block.text !== "string" || block.text.length === 0) continue;
    out.push(block.text);
  }
  return out;
}

export function createAssistantTextCapture(): AssistantTextCapture {
  /** Incomplete trailing line held until its newline arrives. */
  let pending = "";
  let emittedAny = false;
  /** Whether the last emitted byte was a newline — drives separator width. */
  let endsWithNewline = false;
  /** Bounded tail of what we have emitted, for the is_error containment test. */
  let dedupeTail = "";

  /**
   * Whether the last thing emitted was a recovered MESSAGE or a passthrough
   * LINE. Only messages get a synthesised trailing newline — see `end()`.
   */
  let lastWasMessage = false;

  const record = (text: string, kind: "message" | "raw"): void => {
    emittedAny = true;
    lastWasMessage = kind === "message";
    endsWithNewline = text.endsWith("\n");
    dedupeTail = (dedupeTail + text).slice(-DEDUPE_TAIL_LIMIT);
  };

  /**
   * Separator before an assistant MESSAGE: always a blank line between two
   * messages, so a concatenated response reads as prose rather than a run-on.
   */
  const messageSeparator = (): string => {
    if (!emittedAny) return "";
    return endsWithNewline ? "\n" : "\n\n";
  };

  /**
   * Separator before a passthrough LINE: only enough to start it at column 0.
   *
   * Raw lines are a byte stream, not messages — they already carry their own
   * newline. Using the message separator here would insert a blank line between
   * every pair of prose lines, which would break the header's verbatim
   * guarantee for exactly the degraded case that guarantee exists to protect.
   */
  const rawSeparator = (): string => {
    if (!emittedAny || endsWithNewline) return "";
    return "\n";
  };

  const consumeLine = (line: string, terminated: boolean): string => {
    if (line.trim().length === 0) return "";

    /**
     * Emit a line we do not own, byte for byte — INCLUDING whether it ended in
     * a newline. A synthesised one would make `outputSize` disagree with what
     * the child actually wrote, and that byte counter is load-bearing: it is
     * what `minOutputBytes` and the empty check measure.
     */
    const passthrough = (): string => {
      const out = `${rawSeparator()}${line}${terminated ? "\n" : ""}`;
      record(out, "raw");
      return out;
    };

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return passthrough(); // plain prose — the pre-recovery output shape
    }

    if (typeof event.type !== "string" || !STREAM_JSON_EVENT_TYPES.has(event.type)) {
      return passthrough(); // JSON, but not an event vocabulary we recognise
    }

    const texts = extractAssistantText(event);
    if (texts.length > 0) {
      let out = "";
      for (const text of texts) {
        // `messageSeparator()` reads state that `record()` writes, so each block
        // must be recorded before the next one computes its separator.
        const piece = `${messageSeparator()}${text}`;
        out += piece;
        record(piece, "message");
      }
      return out;
    }

    // The terminal `result` event normally just repeats the final assistant
    // message — appending it would duplicate the epilogue we already have. But
    // on a FAILED turn it carries the error prose that print mode would have
    // put on stdout, and `classifyRunOutput` matches `[API Error: ...]` against
    // exactly that text. Keeping it here is what preserves api_error detection
    // once the raw pipe is gone.
    if (event.type === "result" && event.is_error === true) {
      const result = typeof event.result === "string" ? event.result : "";
      if (result.trim().length > 0 && !dedupeTail.includes(result)) {
        const out = `${messageSeparator()}${result}`;
        record(out, "message");
        return out;
      }
    }

    return "";
  };

  return {
    write(chunk: string): string {
      pending += chunk;
      let out = "";

      // Split on newlines, keeping the last (possibly incomplete) fragment. A
      // JSON event can be split across chunk boundaries at any byte, so the
      // remainder must survive until its newline arrives.
      let newlineAt = pending.indexOf("\n");
      while (newlineAt !== -1) {
        const line = pending.slice(0, newlineAt);
        pending = pending.slice(newlineAt + 1);
        out += consumeLine(line, true);
        newlineAt = pending.indexOf("\n");
      }

      return out;
    },

    end(): string {
      // A final event with no trailing newline is still a complete event.
      let out = pending.length > 0 ? consumeLine(pending, false) : "";
      pending = "";

      // Keep a RECOVERED response newline-terminated. Never do this after a
      // passthrough line: that path's whole promise is byte-exactness, and the
      // raw pipe it replaces added nothing of its own.
      if (emittedAny && !endsWithNewline && lastWasMessage) {
        out += "\n";
        endsWithNewline = true;
      }
      return out;
    },
  };
}
