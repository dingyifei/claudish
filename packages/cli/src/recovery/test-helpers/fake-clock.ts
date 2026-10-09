/**
 * A deterministic `RecoveryClock` for the retry-ladder tests.
 *
 * WHY THIS EXISTS RATHER THAN `mock.module()`. The ladder's own gaps are
 * 5/10/30/60/60 seconds and its deadline is derived from `API_TIMEOUT_MS`
 * (270 s at the default), so asserting the schedule against the real clock
 * would cost ~four minutes per assertion and would be flaky at every margin.
 * The project's standing rule forbids mocking shared infrastructure — Bun's
 * module registry bleeds a `mock.module()` into sibling test FILES — so
 * `recovery/clock.ts` exposes an explicit injection seam and this is the thing
 * injected into it.
 *
 * It is not a general fake-timers shim: it implements exactly the four methods
 * `RecoveryClock` declares, and it drives ONLY the recovery subsystem. Real
 * `setTimeout` still works underneath, which is what `drain()` uses to let the
 * awaiting production code make progress between two fired timers.
 */

import type { RecoveryClock } from "../clock.js";

interface FakeTimer {
  at: number;
  fn: () => void;
}

export class FakeClock implements RecoveryClock {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, FakeTimer>();
  /** Handles this clock was asked to `unref`. The grace timer must be in here. */
  readonly unrefed = new Set<number>();

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  unref(handle: unknown): void {
    this.unrefed.add(handle as number);
  }

  /** Armed timer count. A leaked timer is a leaked episode, so tests read this. */
  pending(): number {
    return this.timers.size;
  }

  /** The fire times of every armed timer, ascending. */
  pendingAt(): number[] {
    return [...this.timers.values()].map((t) => t.at).sort((a, b) => a - b);
  }

  /**
   * Move time forward, firing every timer that comes due, in order, and
   * yielding to the real event loop after each one so the code awaiting it can
   * run before the next fires.
   */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      this.t = Math.max(this.t, nextAt);
      const timer = this.timers.get(nextId) as FakeTimer;
      this.timers.delete(nextId);
      timer.fn();
      await drain();
    }
    this.t = target;
    await drain();
  }
}

/** Let the real microtask and macrotask queues catch up. */
export async function drain(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Step `clock` forward until `p` settles, then return its value.
 *
 * The ladder decides its own next gap, so a test cannot know in advance how far
 * to advance; stepping in small increments and re-checking is both simpler and
 * closer to what the real clock does. `maxMs` is FAKE milliseconds — the test
 * itself never sleeps for them.
 */
export async function advanceUntilSettled<T>(
  clock: FakeClock,
  p: Promise<T>,
  maxMs: number,
  stepMs = 1_000
): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  let threw = false;
  p.then(
    (v) => {
      value = v;
      settled = true;
    },
    (e) => {
      error = e;
      threw = true;
      settled = true;
    }
  );
  await drain();
  let spent = 0;
  let idle = 0;
  while (!settled && spent < maxMs) {
    // Jump straight to the next armed timer when there is one. Stepping in
    // fixed increments works too but costs a real event-loop drain per step,
    // which turned a 270-second fake ladder into six real seconds of ticking.
    const next = clock.pendingAt()[0];
    if (next === undefined) {
      // Nothing armed and nothing settled: the production code is between
      // rungs doing REAL async work — a refused connect resolves in about a
      // millisecond, which is more than a few microtasks. Give the real event
      // loop a moment before concluding the fake clock has to move.
      if (idle < 40) {
        idle++;
        await new Promise((r) => setTimeout(r, 1));
        continue;
      }
      idle = 0;
      await clock.advance(stepMs);
      spent += stepMs;
      continue;
    }
    idle = 0;
    const step = Math.max(1, next - clock.now());
    await clock.advance(step);
    spent += step;
  }
  await drain();
  if (!settled) throw new Error(`promise did not settle within ${maxMs} fake ms`);
  if (threw) throw error;
  return value as T;
}

/**
 * A real `AbortSignal` wrapped so a test can COUNT listener registrations.
 *
 * The coordinator's named failure mode is the subscribe-without-unsubscribe
 * leak: a waiter that parks, leaves, and never detaches keeps its closure — and
 * therefore the whole episode — alive for as long as the client's signal
 * exists. `added === removed` is the only direct evidence of the `finally`
 * doing its job; every indirect proxy for it (episode count, timer count) is
 * also true of an implementation that leaks the listener.
 */
export function countingSignal(controller: AbortController): {
  signal: AbortSignal;
  counts: { added: number; removed: number };
} {
  const counts = { added: 0, removed: 0 };
  const real = controller.signal;
  const proxy = {
    get aborted() {
      return real.aborted;
    },
    get reason() {
      return real.reason;
    },
    addEventListener(type: string, fn: EventListener, opts?: AddEventListenerOptions) {
      counts.added++;
      real.addEventListener(type, fn, opts);
    },
    removeEventListener(type: string, fn: EventListener) {
      counts.removed++;
      real.removeEventListener(type, fn);
    },
  };
  return { signal: proxy as unknown as AbortSignal, counts };
}
