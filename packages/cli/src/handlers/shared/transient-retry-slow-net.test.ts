/**
 * F-SLOW — the fault class the rest of the suite structurally cannot exercise.
 *
 * EVERY other fault in this feature's validation set is a loopback refusal, and
 * a refusal comes back in about one millisecond. The originating incident was
 * the opposite: a host that SWALLOWS the connection, where a single connect
 * burns tens of seconds. `192.0.2.1` is TEST-NET-1 (RFC 5737) — reserved for
 * documentation and unrouted — so a TCP connect to it hangs until the OS gives
 * up. Measured on macOS: **75.004 s**, against 0.4 ms for the refused-loopback
 * control.
 *
 * TWO THINGS THAT MATTER AND ARE NOT OBVIOUS:
 *
 *   1. **Slow and fast are indistinguishable BY CODE on macOS.** `192.0.2.1:443`
 *      reports `ConnectionRefused`, the same code as an instantly-refused
 *      loopback port. Only ELAPSED TIME separates them, so any logic that
 *      branches on the code to tell them apart is wrong here.
 *   2. **`PER_ATTEMPT_CONNECT_CAP_MS` must clear the OS's own give-up.** At the
 *      design's original 75 000 the cap raced the operating system by four
 *      milliseconds, and which one won was decided per run. It is 45 000, which
 *      clears it by thirty seconds.
 *
 * WHAT IS IN THE DEFAULT SUITE AND WHAT IS NOT — a deliberate split:
 *
 *   - The test below runs by default. It makes a REAL connect to 192.0.2.1 that
 *     really hangs, and aborts it through the ladder's own clamp on the injected
 *     clock. Real hang, real abort, ~0.1 s of wall clock. What it proves is the
 *     mechanism: the clamp reaches a connect that the OS would otherwise hold
 *     for 75 s, and the resulting abort is re-classified as a failed attempt
 *     rather than escaping as an unrelated error.
 *   - The FULL-FIDELITY run — the real 45 s clamp against a real 75 s connect,
 *     on the real clock — is gated behind `CLAUDISH_SLOW_NET_E2E=1` and costs
 *     ~50 s. Putting it in the default path would add half the suite's total
 *     runtime to every run, for one assertion, and the project's own note about
 *     credential-gated live tests is the precedent for gating rather than
 *     deleting. Its captured output is in the phase log.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetRecoveryClock, setRecoveryClock } from "../../recovery/clock.js";
import { closeAllEpisodes } from "../../recovery/coordinator.js";
import { FakeClock, advanceUntilSettled, drain } from "../../recovery/test-helpers/fake-clock.js";
import { classifyConnectionError, markOwnTimeout } from "./connection-error.js";
import {
  PER_ATTEMPT_CONNECT_CAP_MS,
  mergeSignalIntoInit,
  withConnectionRetry,
} from "./transient-retry.js";

/** TEST-NET-1. Unrouted by RFC, so the connect hangs rather than being refused. */
const SLOW_URL = "https://192.0.2.1/v1/chat/completions";
/** macOS's own measured give-up against an unrouted address. */
const OS_GIVE_UP_MS = 75_004;

let clock: FakeClock;

beforeEach(() => {
  clock = new FakeClock(0);
  setRecoveryClock(clock);
});

afterEach(() => {
  closeAllEpisodes();
  resetRecoveryClock();
});

const CONNECT_FAILURE_SEED = Object.assign(
  new TypeError("Unable to connect. Is the computer able to access the url?"),
  { code: "ConnectionRefused", path: SLOW_URL }
);

describe("F-SLOW — a host that swallows the connection", () => {
  test("the fault is REAL on this machine: the connect does not settle quickly", async () => {
    // The criterion's own precondition: 192.0.2.1 is unrouted BY CONVENTION,
    // and a captive portal or an aggressive corporate resolver can answer it.
    // If it does, every assertion below would pass for the wrong reason, so the
    // fidelity check runs first and says so out loud.
    const ac = new AbortController();
    let settled = false;
    const p = fetch(SLOW_URL, { signal: ac.signal }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 1_500));
    const stillHanging = !settled;
    ac.abort();
    await p.catch(() => {});

    if (!stillHanging) {
      throw new Error(
        `192.0.2.1 settled in ${(performance.now() - t0).toFixed(0)} ms — something on this ` +
          "network answers TEST-NET-1, so F-SLOW is not reproducible here. Substitute a " +
          "locally blackholed route (which needs privileges) and note the substitution."
      );
    }
    expect(stillHanging).toBe(true);
  }, 10_000);

  test("the per-attempt clamp aborts a REAL hung connect far inside the OS's give-up", async () => {
    let opStarted = 0;
    let opSettledAt: number | null = null;
    let abortSeen = false;
    const realElapsed: number[] = [];

    const op = async (signal: AbortSignal) => {
      opStarted++;
      const t0 = performance.now();
      signal.addEventListener("abort", () => {
        abortSeen = true;
      });
      try {
        // A REAL fetch, to a REAL unrouted address, carrying the ladder's own
        // merged signal exactly as `doFetchWith` threads it into the init. The
        // spread order is the point: a signal written before the transport's
        // own init is silently overwritten by it.
        const init = mergeSignalIntoInit({ method: "POST" }, signal);
        return await fetch(SLOW_URL, init);
      } finally {
        realElapsed.push(performance.now() - t0);
        opSettledAt = clock.now();
      }
    };

    const result = await advanceUntilSettled(
      clock,
      withConnectionRetry(op, CONNECT_FAILURE_SEED, {
        providerName: "slow-net",
        providerDisplayName: "Slow Net",
        resolveEndpoint: () => SLOW_URL,
        // One rung of budget: 5 s gap, then the attempt, then no room for
        // another (5 + 45 + 60 + 3 > 60 000).
        deadlineAt: 60_000,
        signal: new AbortController().signal,
      }),
      200_000
    );

    expect(opStarted).toBe(1);
    // The clamp fired — the connect did NOT return on its own.
    expect(abortSeen).toBe(true);
    // On the ladder's clock the attempt ended at the cap, not at the OS's
    // 75.004 s and not at the deadline.
    expect((opSettledAt as unknown as number) - 5_000).toBe(PER_ATTEMPT_CONNECT_CAP_MS);
    // And in REAL time it ended immediately, because the abort reached a live
    // socket rather than waiting the operating system out. This is the number
    // that says the clamp is real and not merely scheduled.
    expect(realElapsed[0] as number).toBeLessThan(5_000);
    expect(PER_ATTEMPT_CONNECT_CAP_MS).toBeLessThan(OS_GIVE_UP_MS - 20_000);

    // The clamp's own abort is a FAILED ATTEMPT of the same kind, not an
    // unrelated error that escapes the ladder.
    expect(result.kind).toBe("exhausted");
    if (result.kind === "exhausted") {
      expect(result.conn.kind).toBeDefined();
    }
    // The deadline is honoured from the inbound request start: everything
    // above happened inside the budget.
    expect(clock.now()).toBeLessThanOrEqual(60_000);
  }, 30_000);

  test("a clamp abort re-classifies as a connection error rather than escaping", () => {
    // Why the ladder can treat its own timeout as a retryable network fault:
    // `AbortSignal.timeout` rejects with a DOMException whose `name` is
    // `TimeoutError` and whose `code` is the NUMBER 23, so a classifier keyed
    // only on a string `code` returned null and a hung probe fell through into
    // a bare 500.
    //
    // `markOwnTimeout` is what the clamp adds — see the sibling test below for
    // why the NAME alone must not be enough.
    const clampAbort = markOwnTimeout(new DOMException("attempt cap", "TimeoutError"));
    const conn = classifyConnectionError(clampAbort);
    expect(conn).not.toBeNull();
    expect(conn?.kind).toBe("unreachable");
  });

  test("slow and fast are indistinguishable BY CODE — only elapsed time separates them", () => {
    // Recorded as an executable note. macOS reports ECONNREFUSED /
    // ConnectionRefused for an unrouted address, the same code an instantly
    // refused loopback port gives. Branching on the code to tell "slow
    // unreachable" from "fast refused" is therefore wrong on this platform.
    const slow = Object.assign(new TypeError("Unable to connect."), {
      code: "ConnectionRefused",
    });
    const fast = Object.assign(new TypeError("Unable to connect."), {
      code: "ConnectionRefused",
    });
    expect(classifyConnectionError(slow)?.kind).toBe(classifyConnectionError(fast)?.kind);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Full fidelity: the real 45 s clamp on the real clock. ~50 s. Gated.
// ───────────────────────────────────────────────────────────────────────────

const LIVE = process.env.CLAUDISH_SLOW_NET_E2E === "1";

describe.skipIf(!LIVE)("F-SLOW, full fidelity (CLAUDISH_SLOW_NET_E2E=1)", () => {
  test("the real clamp ends the attempt at ~45 s, well before the OS's 75.004 s", async () => {
    resetRecoveryClock(); // REAL clock: this is the whole point of the gate.
    let elapsed = 0;
    const op = async (signal: AbortSignal) => {
      const t0 = performance.now();
      try {
        return await fetch(SLOW_URL, mergeSignalIntoInit({ method: "POST" }, signal));
      } finally {
        elapsed = performance.now() - t0;
      }
    };

    const started = performance.now();
    const result = await withConnectionRetry(op, CONNECT_FAILURE_SEED, {
      providerName: "slow-net-live",
      providerDisplayName: "Slow Net Live",
      resolveEndpoint: () => SLOW_URL,
      deadlineAt: performance.now() + 60_000,
      signal: new AbortController().signal,
    });
    const total = performance.now() - started;

    // The numbers ARE the evidence for this criterion, so print them: a gated
    // test that only asserts leaves nothing behind to paste into a phase log.
    console.log(
      `[F-SLOW live] attempt ${(elapsed / 1000).toFixed(3)}s (cap ${
        PER_ATTEMPT_CONNECT_CAP_MS / 1000
      }s, macOS gives up at ${OS_GIVE_UP_MS / 1000}s) · total ${(total / 1000).toFixed(3)}s · ${result.kind}`
    );

    // The attempt ended at the cap, with a wide margin on both sides: not
    // early (it really did hang) and not at the OS's own give-up.
    expect(elapsed).toBeGreaterThan(PER_ATTEMPT_CONNECT_CAP_MS - 2_000);
    expect(elapsed).toBeLessThan(PER_ATTEMPT_CONNECT_CAP_MS + 2_000);
    expect(elapsed).toBeLessThan(OS_GIVE_UP_MS - 20_000);
    // And the deadline held from the inbound request start.
    expect(total).toBeLessThan(60_000);
    expect(result.kind).toBe("exhausted");
    await drain();
  }, 180_000);
});
