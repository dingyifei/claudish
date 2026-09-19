import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractStreamsFromLog,
  groupEventsIntoStreams,
  readSseLines,
} from "./extract-sse-from-log.js";

/**
 * A REAL capture, committed beside this test because a fixture is by definition
 * meant to outlive the session that produced it (see
 * `ai-docs/architecture/testing.md`). It is a `gk@grok-4.6` session whose harness
 * had several upstream requests in flight at once: five distinct response ids,
 * two of which interleave line by line near the end of the log.
 */
const LOG_PATH = join(
  import.meta.dir,
  "debug-logs",
  "edit-empty-new-string-grok46-20260916T164045.log"
);
const LOG = readFileSync(LOG_PATH, "utf-8");

/** Every response id an event in this stream announced. `[DONE]` announces none. */
function announcedIds(events: { data: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    try {
      const parsed = JSON.parse(event.data);
      if (typeof parsed.id === "string") ids.add(parsed.id);
    } catch {
      // `[DONE]`, which belongs to whichever stream it terminates.
    }
  }
  return ids;
}

describe("extract-sse-from-log stream separation", () => {
  it("the capture really does interleave two upstream responses", () => {
    // The guard on every assertion below. Grouping by the "HANDLER STARTED" /
    // "Calling API" markers is only WRONG on a log whose streams overlap; on a
    // serial log both groupings agree, and a test written against one would pass
    // either way. This asserts the input is the hard case.
    const lines = readSseLines(LOG);
    const seen = new Set<string>();
    let interleavings = 0;
    let previous: string | null = null;
    for (const line of lines) {
      let id: string | null = null;
      try {
        id = JSON.parse(line.data).id ?? null;
      } catch {
        continue;
      }
      if (id === null) continue;
      if (previous !== null && id !== previous && seen.has(id)) interleavings++;
      seen.add(id);
      previous = id;
    }
    expect(interleavings).toBeGreaterThan(0);
  });

  it("gives each upstream response its own stream", () => {
    const { model, streams } = extractStreamsFromLog(LOG);
    expect(model).toBe("grok-4.6");
    expect(streams.map((s) => s.streamId)).toEqual([
      "83a24191-8d96-98a1-a2e6-5f9a1ca3d868",
      "55e1d920-30f9-9581-9a9c-ebb98b6e2f81",
      "87e9575d-3fb2-9b05-85fc-c697b503543b",
      "2a265cce-acb9-9c75-a661-fdb887994008",
      "3c04e832-460c-9258-8d61-f1e5f3c5d93e",
    ]);
    expect(streams.map((s) => s.events.length)).toEqual([34, 48, 24, 51, 51]);
  });

  it("never lets a foreign event into a stream", () => {
    // The defect this fixes, stated directly: a merged turn carried 12 events
    // from another response, including a `finish_reason` that decided the
    // outcome of the fixture's own test.
    for (const stream of extractStreamsFromLog(LOG).streams) {
      expect([...announcedIds(stream.events)]).toEqual([stream.streamId as string]);
    }
  });

  it("closes each stream with its own [DONE], and only its own", () => {
    const streams = extractStreamsFromLog(LOG).streams;
    for (const stream of streams) {
      const sentinels = stream.events.filter((e) => e.data.trim() === "[DONE]");
      expect(sentinels).toHaveLength(1);
      expect(stream.events[stream.events.length - 1].data.trim()).toBe("[DONE]");
    }
  });

  it("keeps each stream's events in log order", () => {
    for (const stream of extractStreamsFromLog(LOG).streams) {
      const lines = stream.events.map((e) => e.line);
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
    }
  });

  it("spans the interleaved region rather than stopping at the first foreign event", () => {
    // Stream 1 opens at log line 50 and its `[DONE]` lands at 544, long after
    // streams 2-4 have opened and closed inside that span. A grouping that
    // started a new turn at every marker would cut it into pieces.
    const first = extractStreamsFromLog(LOG).streams[0];
    expect(first.events[0].line).toBe(50);
    expect(first.events[first.events.length - 1].line).toBe(544);
  });
});

/**
 * Branches the real capture does not contain. These call the grouping function
 * with argument values — they are NOT `.sse` fixtures, and nothing here is
 * written to disk or replayed through a parser.
 */
describe("extract-sse-from-log grouping edge cases", () => {
  it("keys an Anthropic stream on the id message_start announces", () => {
    const streams = groupEventsIntoStreams([
      { format: "anthropic", line: 1, data: '{"type":"message_start","message":{"id":"msg_a"}}' },
      { format: "anthropic", line: 2, data: '{"type":"content_block_delta"}' },
      { format: "anthropic", line: 3, data: '{"type":"message_stop"}' },
      { format: "anthropic", line: 4, data: '{"type":"message_start","message":{"id":"msg_b"}}' },
      { format: "anthropic", line: 5, data: '{"type":"message_stop"}' },
    ]);
    expect(streams.map((s) => [s.streamId, s.events.length])).toEqual([
      ["msg_a", 3],
      ["msg_b", 2],
    ]);
  });

  it("keeps a corrupt payload in the stream it interrupted, so the integrity check still sees it", () => {
    const streams = groupEventsIntoStreams([
      { format: "openai", line: 1, data: '{"id":"a","choices":[]}' },
      { format: "openai", line: 2, data: '{"id":"a","choic' },
      { format: "openai", line: 3, data: "[DONE]" },
    ]);
    expect(streams).toHaveLength(1);
    expect(streams[0].events.map((e) => e.line)).toEqual([1, 2, 3]);
  });

  it("does not merge two responses because a capture began mid-stream", () => {
    const streams = groupEventsIntoStreams([
      { format: "openai", line: 1, data: "[DONE]" },
      { format: "openai", line: 2, data: '{"id":"b","choices":[]}' },
    ]);
    expect(streams.map((s) => s.streamId)).toEqual([null, "b"]);
  });

  it("opens a new stream when an id is reused after its [DONE]", () => {
    const streams = groupEventsIntoStreams([
      { format: "openai", line: 1, data: '{"id":"a","choices":[]}' },
      { format: "openai", line: 2, data: "[DONE]" },
      { format: "openai", line: 3, data: '{"id":"a","choices":[]}' },
      { format: "openai", line: 4, data: "[DONE]" },
    ]);
    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.events.length)).toEqual([2, 2]);
  });
});
