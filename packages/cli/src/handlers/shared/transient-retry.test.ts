/**
 * The tier-1 retry ladder.
 *
 * This file carries **C-2** (the backoff schedule) and the unit half of **C-9**
 * (client disconnect). Both run on the injected clock, so the 5/10/30/60/60
 * sequence and the 270-second deadline are asserted in milliseconds of real
 * time rather than in minutes.
 *
 * The ladder's single most mis-readable property: **the last delay REPEATS.**
 * `CONNECTION_RETRY_DELAYS_MS` has four elements and the schedule is
 * 5/10/30/60/60/60/… forever — the DEADLINE ends it, not the array. That
 * inverts `STREAM_RETRY_DELAYS_MS`, where the array running out IS the budget,
 * and an implementation that copied the sibling's shape would stop after four
 * gaps with most of the budget unspent.
 *
 * Fixtures are PROVOKED from a real `fetch` refusal, never hand-written: Bun's
 * fetch uses neither Node's errno names nor `.cause`, so a hand-written
 * `{ code: "ECONNREFUSED" }` would test the classifier's table instead of the
 * runtime's behaviour.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { resetRecoveryClock, setRecoveryClock } from "../../recovery/clock.js";
import { closeAllEpisodes, describeEpisode, episodeCount } from "../../recovery/coordinator.js";
import { FakeClock, advanceUntilSettled, drain } from "../../recovery/test-helpers/fake-clock.js";
import {
  CONNECTION_RETRY_DELAYS_MS,
  MIN_ATTEMPT_SLOT_MS,
  PER_ATTEMPT_CONNECT_CAP_MS,
  connectionRetryDelayMs,
  inboundStartedAtPerf,
  mergeSignalIntoInit,
  refreshDeadlineAt,
  tier1DeadlineAt,
  withConnectionRetry,
} from "./transient-retry.js";

// ───────────────────────────────────────────────────────────────────────────
// Fixture — provoked, not hand-written
// ───────────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let CONNECT_FAILURE: unknown;

beforeAll(async () => {
  try {
    await realFetch("http://127.0.0.1:1/refused-on-purpose");
    throw new Error("127.0.0.1:1 accepted a connection — this fixture needs a closed port");
  } catch (e) {
    CONNECT_FAILURE = e;
  }
  // Guard the guard. If Bun ever stops setting a recognisable code, every
  // assertion below would go green for the wrong reason.
  expect((CONNECT_FAILURE as { code?: string }).code).toBe("ConnectionRefused");
});

let clock: FakeClock;
function useFakeClock(start = 0): FakeClock {
  clock = new FakeClock(start);
  setRecoveryClock(clock);
  return clock;
}

afterEach(() => {
  closeAllEpisodes();
  resetRecoveryClock();
});

let seq = 0;
function ctx(overrides: Record<string, unknown> = {}) {
  return {
    providerName: `ladder-${++seq}`,
    providerDisplayName: "Ladder Probe",
    resolveEndpoint: () => "http://127.0.0.1:1/v1/chat/completions",
    deadlineAt: 270_000,
    signal: new AbortController().signal,
    ...overrides,
  } as Parameters<typeof withConnectionRetry>[2];
}

/** An `op` that always fails the way a dead socket does, recording WHEN. */
function failingOp(at: number[]) {
  return async (_signal: AbortSignal) => {
    at.push(clock.now());
    throw CONNECT_FAILURE;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The schedule itself
// ───────────────────────────────────────────────────────────────────────────

describe("CONNECTION_RETRY_DELAYS_MS", () => {
  test("is exactly [5000, 10000, 30000, 60000]", () => {
    expect([...CONNECTION_RETRY_DELAYS_MS]).toEqual([5_000, 10_000, 30_000, 60_000]);
  });

  test("is not the stream-retry schedule — the two budgets are unrelated", async () => {
    const { STREAM_RETRY_DELAYS_MS } = (await import("../composed-handler.js")) as unknown as {
      STREAM_RETRY_DELAYS_MS?: readonly number[];
    };
    // Not exported today; the point of the assertion is that if it ever is,
    // the two schedules must still differ. Merging them couples the sniffer's
    // 12 s budget to the connect ladder.
    if (STREAM_RETRY_DELAYS_MS) {
      expect([...STREAM_RETRY_DELAYS_MS]).not.toEqual([...CONNECTION_RETRY_DELAYS_MS]);
    }
    expect(CONNECTION_RETRY_DELAYS_MS.length).toBe(4);
  });
});

describe("connectionRetryDelayMs — the LAST element repeats", () => {
  test("indexes the array for 0..2", () => {
    expect(connectionRetryDelayMs(0)).toBe(5_000);
    expect(connectionRetryDelayMs(1)).toBe(10_000);
    expect(connectionRetryDelayMs(2)).toBe(30_000);
  });

  test("returns 60000 for EVERY n ≥ 3 — the budget ends the ladder, not the array", () => {
    for (const n of [3, 4, 5, 6, 10, 99, 1_000, Number.MAX_SAFE_INTEGER]) {
      expect(connectionRetryDelayMs(n)).toBe(60_000);
    }
    // An implementation that ran off the end would return undefined here, and
    // `setTimeout(fn, undefined)` fires immediately — a tight loop against a
    // dead host rather than a one-minute gap.
    expect(connectionRetryDelayMs(4)).not.toBeUndefined();
  });

  test("a negative index clamps to the first rung rather than to undefined", () => {
    expect(connectionRetryDelayMs(-1)).toBe(5_000);
    expect(connectionRetryDelayMs(-100)).toBe(5_000);
  });
});

describe("the per-attempt cap clears the OS's own give-up", () => {
  test("is 45 s — NOT 75 000, which races macOS's 75.004 s by 4 ms", () => {
    expect(PER_ATTEMPT_CONNECT_CAP_MS).toBe(45_000);
    // Measured: macOS gives up on an unrouted address at 75.004 s. A cap at
    // 75 000 is decided differently on different runs, which makes every
    // assertion keyed on "the attempt ended at the clamp" flaky by
    // construction. The margin below is the whole reason for the number.
    expect(75_004 - PER_ATTEMPT_CONNECT_CAP_MS).toBeGreaterThan(20_000);
  });

  test("refreshDeadlineAt reserves exactly one unclamped attempt", () => {
    expect(refreshDeadlineAt(270_000)).toBe(270_000 - PER_ATTEMPT_CONNECT_CAP_MS);
    expect(refreshDeadlineAt(270_000)).toBe(225_000);
  });

  test("MIN_ATTEMPT_SLOT_MS is 3 s", () => {
    expect(MIN_ATTEMPT_SLOT_MS).toBe(3_000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C-2 — the observed gaps
// ───────────────────────────────────────────────────────────────────────────

describe("C-2 — the backoff schedule is the specified one", () => {
  test("gaps are 5/10/30/60/60/60 and the ladder exhausts at the computed attempt", async () => {
    const c = useFakeClock(0);
    const at: number[] = [];
    const deadlineAt = 270_000; // the default, derived from API_TIMEOUT_MS
    const result = await advanceUntilSettled(
      c,
      withConnectionRetry(failingOp(at), CONNECT_FAILURE, ctx({ deadlineAt })),
      400_000
    );

    // Attempt 1 is the caller's own failure, outside this function, so `at`
    // holds the RE-ISSUES. Their absolute times:
    expect(at).toEqual([5_000, 15_000, 45_000, 105_000, 165_000, 225_000]);

    const gaps = at.map((t, i) => t - (i === 0 ? 0 : (at[i - 1] as number)));
    expect(gaps).toEqual([5_000, 10_000, 30_000, 60_000, 60_000, 60_000]);

    // Seven attempts in the episode: the opening failure plus six re-issues.
    expect(result.kind).toBe("exhausted");
    expect(result.attempts).toBe(7);

    // Exhaustion is a CEILING by construction: the last failure lands before
    // the deadline, and the next rung would not fit.
    const last = at[at.length - 1] as number;
    expect(last).toBeLessThan(deadlineAt);
    expect(last + connectionRetryDelayMs(6) + MIN_ATTEMPT_SLOT_MS).toBeGreaterThan(deadlineAt);
    expect(c.now()).toBeLessThanOrEqual(deadlineAt);
  });

  test("the sequence is deadline-driven, not array-driven: a 30 s budget stops at 2 gaps", async () => {
    // The shape a user with API_TIMEOUT_MS=60000 gets. The gaps are the SAME
    // first rungs; only how many of them fit changes.
    const c = useFakeClock(0);
    const at: number[] = [];
    const result = await advanceUntilSettled(
      c,
      withConnectionRetry(failingOp(at), CONNECT_FAILURE, ctx({ deadlineAt: 30_000 })),
      120_000
    );
    expect(at).toEqual([5_000, 15_000]);
    expect(result.kind).toBe("exhausted");
    expect(result.attempts).toBe(3);
  });

  test("a 15 s floor budget still buys one real retry", async () => {
    const c = useFakeClock(0);
    const at: number[] = [];
    await advanceUntilSettled(
      c,
      withConnectionRetry(failingOp(at), CONNECT_FAILURE, ctx({ deadlineAt: 15_000 })),
      60_000
    );
    // 5 + 3 = 8 ≤ 15, so one rung fits; 5 + 10 + 3 = 18 > 15, so a second
    // does not. Anything under 8 s would make the ladder a pure delay in
    // front of the same 400.
    expect(at).toEqual([5_000]);
  });

  test("the deadline check bounds the ATTEMPT THAT FOLLOWS the sleep, not just the sleep", async () => {
    // 165 000 + 60 000 = 225 000 < 240 000, so a check that bounded only the
    // SLEEP would start a seventh attempt with 15 s of budget left. It must
    // not: MIN_ATTEMPT_SLOT_MS is part of the comparison.
    const c = useFakeClock(0);
    const at: number[] = [];
    await advanceUntilSettled(
      c,
      withConnectionRetry(failingOp(at), CONNECT_FAILURE, ctx({ deadlineAt: 226_000 })),
      400_000
    );
    expect(at).toEqual([5_000, 15_000, 45_000, 105_000, 165_000]);
    expect(at).not.toContain(225_000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Recovery, and the outcomes that are not recovery
// ───────────────────────────────────────────────────────────────────────────

describe("a re-issue that succeeds returns the value and stops the ladder", () => {
  test("`ok` on the third attempt — no fourth attempt is ever made", async () => {
    const c = useFakeClock(0);
    const at: number[] = [];
    const op = async (_s: AbortSignal) => {
      at.push(c.now());
      if (at.length < 3) throw CONNECT_FAILURE;
      return { body: "a real upstream Response would be here" };
    };

    const result = await advanceUntilSettled(
      c,
      withConnectionRetry(op, CONNECT_FAILURE, ctx()),
      400_000
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.value).toEqual({ body: "a real upstream Response would be here" });
    // Two failed re-issues, then the success — and then nothing.
    expect(at).toEqual([5_000, 15_000, 45_000]);
    expect(result.attempts).toBe(4);
    expect(result.recoveryMs).toBe(45_000);
    expect(result.episodeId).not.toBe("");
    // Ladder stopped: no timer left armed, no episode left open.
    expect(c.pending()).toBe(0);
    expect(episodeCount()).toBe(0);
  });

  test("an immediate success on the FIRST re-issue costs exactly one gap", async () => {
    const c = useFakeClock(0);
    const result = await advanceUntilSettled(
      c,
      withConnectionRetry(async () => "ok", CONNECT_FAILURE, ctx()),
      60_000
    );
    expect(result.kind).toBe("ok");
    expect(c.now()).toBe(5_000);
    expect(result.attempts).toBe(2);
  });
});

describe("outcomes that are not recovery", () => {
  test("an unclassifiable later throw comes back as `threw`, not as the network error", async () => {
    // HIGH-10. A retry that throws an auth failure, a transport bug or a
    // programming error must not be relabelled as the previous connection
    // error — that would quietly widen recovery past the classified set.
    const c = useFakeClock(0);
    const boom = new TypeError("undefined is not a function");
    let n = 0;
    const op = async () => {
      n++;
      throw boom;
    };
    const result = await advanceUntilSettled(
      c,
      withConnectionRetry(op, CONNECT_FAILURE, ctx()),
      60_000
    );
    expect(result.kind).toBe("threw");
    if (result.kind !== "threw") throw new Error("unreachable");
    expect(result.error).toBe(boom);
    expect(n).toBe(1);
    expect(c.pending()).toBe(0);
  });

  test("an unclassifiable FIRST failure is refused rather than retried", async () => {
    const c = useFakeClock(0);
    let called = false;
    const result = await withConnectionRetry(
      async () => {
        called = true;
        return "never";
      },
      new TypeError("not a network failure"),
      ctx()
    );
    expect(result.kind).toBe("threw");
    expect(called).toBe(false);
    expect(episodeCount()).toBe(0);
    expect(c.pending()).toBe(0);
  });

  test("`gave_up` when the episode is abandoned under a parked waiter", async () => {
    useFakeClock(0);
    const at: number[] = [];
    const p = withConnectionRetry(failingOp(at), CONNECT_FAILURE, ctx());
    await drain();
    closeAllEpisodes("gave_up");
    const result = await p;
    expect(result.kind).toBe("gave_up");
    expect(at).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C-9 — the client going away
// ───────────────────────────────────────────────────────────────────────────

describe("C-9 — a client disconnect stops the loop and cancels the upstream fetch", () => {
  test("aborting mid-gap resolves `client_gone`, clears the timer and releases the episode", async () => {
    const c = useFakeClock(0);
    const ac = new AbortController();
    const at: number[] = [];
    const p = withConnectionRetry(failingOp(at), CONNECT_FAILURE, ctx({ signal: ac.signal }));
    await drain();
    expect(c.pending()).toBe(1);

    ac.abort(new DOMException("client gone", "AbortError"));
    const result = await p;

    expect(result.kind).toBe("client_gone");
    // No attempt was made after the abort.
    expect(at).toEqual([]);
    // The timer is gone and the episode is released AT ONCE — not after the
    // 120 s handoff grace, which applies only to a deliberate tier-2 handoff.
    expect(c.pending()).toBe(0);
    expect(episodeCount()).toBe(0);
    expect(describeEpisode(result.episodeId)).toBeNull();
  });

  test("the signal handed to `op` aborts with the client — the upstream fetch is cancelled", async () => {
    const c = useFakeClock(0);
    const ac = new AbortController();
    let inFlight: AbortSignal | null = null;
    let abortedDuringOp = false;

    const op = (signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        inFlight = signal;
        signal.addEventListener("abort", () => {
          abortedDuringOp = true;
          reject(signal.reason);
        });
      });

    const p = withConnectionRetry(op, CONNECT_FAILURE, ctx({ signal: ac.signal }));
    await drain();
    await c.advance(5_000); // first rung fires, op starts and hangs
    expect(inFlight).not.toBeNull();
    expect((inFlight as unknown as AbortSignal).aborted).toBe(false);

    ac.abort(new DOMException("client gone", "AbortError"));
    const result = await p;

    // This is what "the upstream fetch is cancelled" means concretely: the
    // signal `op` was handed — the one merged into the real fetch init — is
    // the one that fired.
    expect(abortedDuringOp).toBe(true);
    expect(result.kind).toBe("client_gone");
    expect(c.pending()).toBe(0);
    expect(episodeCount()).toBe(0);
  });

  test("an already-aborted client is answered without a single attempt", async () => {
    const c = useFakeClock(0);
    const ac = new AbortController();
    ac.abort(new DOMException("gone", "AbortError"));
    const at: number[] = [];
    const result = await withConnectionRetry(
      failingOp(at),
      CONNECT_FAILURE,
      ctx({ signal: ac.signal })
    );
    expect(result.kind).toBe("client_gone");
    expect(at).toEqual([]);
    expect(c.pending()).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The per-attempt clamp
// ───────────────────────────────────────────────────────────────────────────

describe("the per-attempt clamp bounds the OPERATION, not just the fetch inside it", () => {
  test("a hung attempt is aborted at the cap and counted as a failed attempt", async () => {
    const c = useFakeClock(0);
    const starts: number[] = [];
    const ends: number[] = [];
    const op = (signal: AbortSignal) =>
      new Promise<string>((_res, rej) => {
        starts.push(c.now());
        signal.addEventListener("abort", () => {
          ends.push(c.now());
          rej(signal.reason);
        });
      });

    const result = await advanceUntilSettled(
      c,
      withConnectionRetry(op, CONNECT_FAILURE, ctx({ deadlineAt: 270_000 })),
      400_000
    );

    expect(starts[0]).toBe(5_000);
    // Aborted at the cap, not at the OS's 75 s and not at the deadline.
    expect((ends[0] as number) - (starts[0] as number)).toBe(PER_ATTEMPT_CONNECT_CAP_MS);
    // The clamp's own abort is re-classified as a failed attempt of the same
    // kind rather than escaping as an unrelated error.
    expect(result.kind).toBe("exhausted");
    // Every attempt costs its gap plus the full cap, so the deadline is still
    // honoured from the inbound request start.
    expect(c.now()).toBeLessThanOrEqual(270_000);
  });

  test("the clamp shrinks to the REMAINING budget when that is smaller than the cap", async () => {
    const c = useFakeClock(0);
    const starts: number[] = [];
    const ends: number[] = [];
    const op = (signal: AbortSignal) =>
      new Promise<string>((_res, rej) => {
        starts.push(c.now());
        signal.addEventListener("abort", () => {
          ends.push(c.now());
          rej(signal.reason);
        });
      });
    // 5 s gap, then only 15 s of budget left — less than the 45 s cap.
    await advanceUntilSettled(
      c,
      withConnectionRetry(op, CONNECT_FAILURE, ctx({ deadlineAt: 20_000 })),
      120_000
    );
    expect(starts[0]).toBe(5_000);
    expect((ends[0] as number) - (starts[0] as number)).toBe(15_000);
  });

  test("the clamp is disarmed the instant the operation settles", async () => {
    const c = useFakeClock(0);
    await advanceUntilSettled(
      c,
      withConnectionRetry(async () => "ok", CONNECT_FAILURE, ctx()),
      60_000
    );
    // If the clamp outlived the attempt it would still be armed here, and on
    // the real clock it would abort a signal already merged into a live
    // streaming body.
    expect(c.pending()).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The deadline's origin
// ───────────────────────────────────────────────────────────────────────────

describe("the deadline is anchored to the INBOUND request, not to the candidate", () => {
  function fakeContext(raw?: Request): Context {
    return { req: { raw, header: () => undefined } } as unknown as Context;
  }

  test("every candidate in one chain inherits the FIRST candidate's start", () => {
    const c = useFakeClock(1_000);
    const raw = new Request("http://127.0.0.1:1/v1/messages", { method: "POST" });
    const first = inboundStartedAtPerf(fakeContext(raw));
    expect(first).toBe(1_000);

    // The fallback handler calls handle() once PER CANDIDATE, and each mints
    // its own `startTime`. Without the shared anchor a three-candidate chain
    // could hold one socket for three full deadlines.
    c.advance(50_000);
    const second = inboundStartedAtPerf(fakeContext(raw));
    expect(second).toBe(1_000);
  });

  test("a different inbound request gets its own anchor", async () => {
    const c = useFakeClock(0);
    const a = new Request("http://127.0.0.1:1/a", { method: "POST" });
    const b = new Request("http://127.0.0.1:1/b", { method: "POST" });
    expect(inboundStartedAtPerf(fakeContext(a))).toBe(0);
    await c.advance(7_000);
    expect(inboundStartedAtPerf(fakeContext(b))).toBe(7_000);
    expect(inboundStartedAtPerf(fakeContext(a))).toBe(0);
  });

  test("a synthesised Context with no raw Request still yields a usable anchor", () => {
    useFakeClock(4_242);
    expect(inboundStartedAtPerf(fakeContext(undefined))).toBe(4_242);
  });

  test("tier1DeadlineAt = anchor + the DERIVED budget, and it moves with API_TIMEOUT_MS", () => {
    useFakeClock(1_000);
    const raw = new Request("http://127.0.0.1:1/deadline", { method: "POST" });
    const saved = process.env.API_TIMEOUT_MS;
    try {
      delete process.env.API_TIMEOUT_MS;
      expect(tier1DeadlineAt(fakeContext(raw))).toBe(1_000 + 270_000);

      const raw2 = new Request("http://127.0.0.1:1/deadline2", { method: "POST" });
      process.env.API_TIMEOUT_MS = "60000";
      // Same anchor arithmetic, different budget — the number is derived, not
      // pinned. A user with a 60 s client must not be handed a 270 s hold.
      expect(tier1DeadlineAt(fakeContext(raw2))).toBe(1_000 + 30_000);
    } finally {
      if (saved === undefined) delete process.env.API_TIMEOUT_MS;
      else process.env.API_TIMEOUT_MS = saved;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Signal composition
// ───────────────────────────────────────────────────────────────────────────

describe("mergeSignalIntoInit composes rather than replaces", () => {
  test("the transport's own signal survives beside the clamp", async () => {
    const own = new AbortController();
    const ours = new AbortController();
    const init = mergeSignalIntoInit({ method: "POST", signal: own.signal }, ours.signal);
    const merged = init.signal as AbortSignal;
    expect(merged).not.toBe(own.signal);
    expect(merged).not.toBe(ours.signal);

    // Either one aborts the merged signal — which is what makes the local
    // transport's ten-minute ceiling and our 45 s clamp both apply.
    expect(merged.aborted).toBe(false);
    own.abort(new DOMException("transport ceiling", "TimeoutError"));
    await drain(1);
    expect(merged.aborted).toBe(true);

    const init2 = mergeSignalIntoInit({ signal: new AbortController().signal }, ours.signal);
    ours.abort(new DOMException("attempt cap", "TimeoutError"));
    await drain(1);
    expect((init2.signal as AbortSignal).aborted).toBe(true);
  });

  test("no own signal ⇒ ours is used directly; no signal of ours ⇒ the init is untouched", () => {
    const ours = new AbortController().signal;
    expect(mergeSignalIntoInit({ method: "POST" }, ours).signal).toBe(ours);
    const bare = { method: "POST" };
    expect(mergeSignalIntoInit(bare, undefined)).toBe(bare as unknown as RequestInit);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The clamp binds operations that cannot take a signal
// ───────────────────────────────────────────────────────────────────────────

describe("the per-attempt clamp bounds an op that IGNORES its signal", () => {
  /**
   * The fetch path threads the signal into `fetch`. THE AUTH PATH CANNOT:
   * `refreshAuth()` and `getHeaders()` take no arguments, so the handler's
   * `() => this.provider.refreshAuth!()` discards the signal, and Grok's token
   * exchange then performs an unbounded `fetch(auth.x.ai/oauth2/token)`. A
   * swallowed connection there outlived the 45-second cap AND the client's own
   * disconnect, while this function sat awaiting a promise nothing could
   * settle — the unbounded hold this whole feature exists to remove, reached
   * from inside the machinery that removes it.
   *
   * A deadline one path can ignore is not a deadline, so it is enforced at the
   * one place that owns it.
   */
  test("an attempt that never settles ends at the cap and the ladder goes on", async () => {
    useFakeClock();
    const started: number[] = [];
    let settled = 0;
    // Signal ignored entirely, exactly like `() => provider.refreshAuth!()`.
    const deafOp = async () => {
      started.push(clock.now());
      if (started.length === 1) {
        await new Promise(() => {}); // never settles, never observes the signal
      }
      settled++;
      throw CONNECT_FAILURE;
    };

    const result = await advanceUntilSettled(
      clock,
      withConnectionRetry(deafOp, CONNECT_FAILURE, ctx({ deadlineAt: 200_000 })),
      400_000
    );

    // Attempt 1 was abandoned at the cap rather than awaited forever, so the
    // ladder reached its later rungs and the request answered inside its
    // budget. Without the enforcement this promise never resolves at all.
    expect(started.length).toBeGreaterThan(1);
    // Attempt 1 ended AT THE CAP — not at the deadline, and not never — and the
    // next rung's own gap follows it.
    expect((started[1] as number) - (started[0] as number)).toBe(
      PER_ATTEMPT_CONNECT_CAP_MS + connectionRetryDelayMs(1)
    );
    expect(result.kind).toBe("exhausted");
    expect(settled).toBeGreaterThan(0);
  }, 15_000);

  test("a client disconnect releases such an op too, not only a fetch", async () => {
    useFakeClock();
    const ac = new AbortController();
    const deafOp = async () => {
      ac.abort(new DOMException("client gone", "AbortError"));
      await new Promise(() => {});
      return "never" as unknown;
    };

    const result = await advanceUntilSettled(
      clock,
      withConnectionRetry(deafOp, CONNECT_FAILURE, ctx({ signal: ac.signal })),
      400_000
    );

    // NFR-2 for the auth path: the socket is already gone, so the waiter must
    // unwind now rather than when an unbounded auth fetch eventually gives up.
    expect(result.kind).toBe("client_gone");
    expect(episodeCount()).toBe(0);
  }, 15_000);
});
