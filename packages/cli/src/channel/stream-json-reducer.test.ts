import { describe, expect, test } from "bun:test";

import { ScrollbackBuffer } from "./scrollback-buffer.js";
import {
  type ResultSummary,
  StreamJsonReducer,
  type StreamJsonReducerOptions,
} from "./stream-json-reducer.js";
import {
  CAPTURED_ASSISTANT_FRAME,
  CAPTURED_ASSISTANT_PROSE,
  CAPTURED_DELTA_LINE,
  CAPTURED_RATE_LIMIT_LINE,
  CAPTURED_STATUS_LINE,
  capturedSuccessResult,
} from "./test-helpers/captured-stream-json.js";
import type { ReducerEvent } from "./types.js";

function line(frame: Record<string, unknown>): string {
  return `${JSON.stringify(frame)}\n`;
}

describe("StreamJsonReducer", () => {
  test("captured semantic frames drive state, prose, result accounting, and diagnostics", () => {
    const events: ReducerEvent[] = [];
    const semanticLines: string[] = [];
    let summary: ResultSummary | undefined;
    const options: StreamJsonReducerOptions = {
      sessionId: "reducer-test",
      stallSeconds: 0,
      callback: (_sessionId, event) => events.push(event),
      onSemanticLine: (semanticLine) => semanticLines.push(semanticLine),
      onResult: (result) => {
        summary = result;
      },
    };
    const reducer = new StreamJsonReducer(options);

    let prose = "";
    prose += reducer.feed(`${CAPTURED_STATUS_LINE}\n`);
    prose += reducer.feed(line(CAPTURED_ASSISTANT_FRAME));
    prose += reducer.feed(`${CAPTURED_RATE_LIMIT_LINE}\n`);
    prose += reducer.feed(line(capturedSuccessResult(CAPTURED_ASSISTANT_PROSE)));
    prose += reducer.end();

    expect(events.map((event) => event.newState)).toEqual(["running", "waiting_for_input"]);
    expect(prose).toBe(`${CAPTURED_ASSISTANT_PROSE}\n`);
    expect(reducer.state).toBe("waiting_for_input");
    expect(reducer.sawResult).toBe(true);
    expect(reducer.turns).toBe(1);
    expect(reducer.tokens).toBeGreaterThan(0);
    expect(summary?.terminalReason).toBe("completed");
    expect(semanticLines).toHaveLength(4);
    expect(semanticLines).toContain(CAPTURED_RATE_LIMIT_LINE);
    reducer.dispose();
  });

  test("G6: delta firehose never evicts real assistant prose from scrollback", () => {
    const scrollback = new ScrollbackBuffer(2000);
    const reducer = new StreamJsonReducer({
      sessionId: "delta-regression",
      stallSeconds: 0,
      callback: () => {},
    });
    const appendRecovered = (chunk: string): void => {
      const recovered = reducer.feed(chunk);
      if (recovered) scrollback.append(recovered);
    };

    // This assistant frame and the delta frame both come from the captured
    // bidirectional probe. Assistant prose arrives first, exactly as it would
    // be vulnerable to eviction during a long generation.
    for (let index = 0; index < 5; index++) {
      appendRecovered(line(CAPTURED_ASSISTANT_FRAME));
    }
    for (let index = 0; index < 3000; index++) {
      appendRecovered(`${CAPTURED_DELTA_LINE}\n`);
    }
    const tail = reducer.end();
    if (tail) scrollback.append(tail);

    const stored = scrollback.getLines().join("\n");
    expect(stored).toContain(CAPTURED_ASSISTANT_PROSE);
    expect(stored).not.toContain('"type":"stream_event"');
    expect(scrollback.totalLines).toBeLessThan(100);
    reducer.dispose();
  });
});
