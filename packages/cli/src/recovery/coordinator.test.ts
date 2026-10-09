/**
 * The episode coordinator.
 *
 * Four properties are load-bearing and each one was a review finding before it
 * was a test:
 *
 *   1. N waiters on one target share ONE timer. Without this an outage costs N
 *      ladders, N sets of connect attempts against a dead network, and N
 *      unsynchronised countdowns.
 *   2. A waiter past its OWN deadline answers alone and LEAVES THE OTHERS
 *      RUNNING. The previous revision let one waiter's deadline move the shared
 *      episode into `handoff` — a state with no timer — so every other parked
 *      waiter silently stopped being retried and answered having attempted
 *      nothing. The visible symptom was `waiters: 4` with one of them actually
 *      being retried.
 *   3. The waiter set is EMPTY after an aborted wait, and the abort listener is
 *      detached. This is the Observer leak the design named as its own most
 *      likely failure mode.
 *   4. A request arriving inside `EPISODE_GRACE_MS` REJOINS: same episode id,
 *      same ladder position. Restarting the ladder at 5 s would hammer a dead
 *      host harder the longer the outage lasted.
 *
 * Every test runs on the injected clock. None of them sleeps.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resetRecoveryClock, setRecoveryClock } from "./clock.js";
import {
  EPISODE_GRACE_MS,
  closeAllEpisodes,
  describeEpisode,
  episodeCount,
  giveUp,
  joinEpisode,
  noteTargetReachable,
  uiLeaseValid,
} from "./coordinator.js";
import type { WaitOutcome } from "./coordinator.js";
import { FakeClock, countingSignal, drain } from "./test-helpers/fake-clock.js";

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
/** A fresh provider name per test, because episodes are keyed by provider|host. */
function seed(overrides: Partial<Parameters<typeof joinEpisode>[0]> = {}) {
  const name = overrides.providerName ?? `coord-${++seq}`;
  return {
    providerName: name,
    providerDisplayName: "Coord Probe",
    endpoint: "http://127.0.0.1:9/v1/chat/completions",
    kind: "refused" as const,
    code: "ConnectionRefused",
    reason: "Cannot reach Coord Probe",
    deadlineAt: 270_000,
    ...overrides,
  };
}

const never = () => new AbortController().signal;

// ───────────────────────────────────────────────────────────────────────────
// 1. One episode, one timer
// ───────────────────────────────────────────────────────────────────────────

describe("one episode per target, one timer for every waiter", () => {
  test("two waiters on the same key share ONE episode and ONE timer", async () => {
    useFakeClock();
    const s = seed();
    const a = joinEpisode(s);
    const b = joinEpisode(s);

    expect(a.episodeId).toBe(b.episodeId);
    expect(episodeCount()).toBe(1);
    expect(describeEpisode(a.episodeId)?.waiters).toBe(2);

    let wokeA = false;
    let wokeB = false;
    const pa = a.waitForNextAttempt(never(), 5_000).then(() => {
      wokeA = true;
    });
    await drain();
    // B joins the round already in flight and INHERITS the running gap rather
    // than arming a second timer or restarting the first.
    const pb = b.waitForNextAttempt(never(), 5_000).then(() => {
      wokeB = true;
    });
    await drain();

    expect(clock.pending()).toBe(1);
    expect(clock.pendingAt()).toEqual([5_000]);

    await clock.advance(5_000);
    await Promise.all([pa, pb]);
    expect(wokeA).toBe(true);
    expect(wokeB).toBe(true);
    expect(clock.pending()).toBe(0);

    a.leave();
    b.leave();
  });

  test("a waiter joining MID-GAP inherits the remaining time, it does not restart it", async () => {
    useFakeClock();
    const s = seed();
    const a = joinEpisode(s);
    const pa = a.waitForNextAttempt(never(), 60_000);
    await drain();
    expect(clock.pendingAt()).toEqual([60_000]);

    await clock.advance(50_000); // t = 50 000, 10 s of the gap left
    const b = joinEpisode(s);
    const pb = b.waitForNextAttempt(never(), 60_000);
    await drain();

    // Still one timer, still due at 60 000 — not at 110 000.
    expect(clock.pending()).toBe(1);
    expect(clock.pendingAt()).toEqual([60_000]);

    await clock.advance(10_000);
    await Promise.all([pa, pb]);
    expect(clock.now()).toBe(60_000);
    a.leave();
    b.leave();
  });

  test("different targets get different episodes", () => {
    useFakeClock();
    const a = joinEpisode(seed({ providerName: "alpha" }));
    const b = joinEpisode(seed({ providerName: "beta" }));
    expect(a.episodeId).not.toBe(b.episodeId);
    expect(episodeCount()).toBe(2);
    a.leave();
    b.leave();
  });

  test("the ladder advances ONCE per round however many waiters attempted it", async () => {
    useFakeClock();
    const s = seed();
    const a = joinEpisode(s);
    const b = joinEpisode(s);
    const c = joinEpisode(s);

    // The opening failure: three waiters, one round, index must stay at 0 so
    // the first gap is the ladder's FIRST rung.
    a.recordAttemptResult("ConnectionRefused", false);
    b.recordAttemptResult("ConnectionRefused", false);
    c.recordAttemptResult("ConnectionRefused", false);
    expect(a.ladderIndex()).toBe(0);
    expect(a.attempts()).toBe(3);

    const parked = Promise.all([
      a.waitForNextAttempt(never(), 5_000),
      b.waitForNextAttempt(never(), 5_000),
      c.waitForNextAttempt(never(), 5_000),
    ]);
    await drain();
    await clock.advance(5_000);
    await parked;

    a.recordAttemptResult("ConnectionRefused", false);
    b.recordAttemptResult("ConnectionRefused", false);
    c.recordAttemptResult("ConnectionRefused", false);
    // One round, one advance — not three.
    expect(a.ladderIndex()).toBe(1);
    expect(a.attempts()).toBe(6);

    a.leave();
    b.leave();
    c.leave();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. A waiter's deadline is its own
// ───────────────────────────────────────────────────────────────────────────

describe("a waiter past its own deadline leaves WITHOUT stranding the others", () => {
  test("the shared ladder keeps running for the waiter that still has budget", async () => {
    useFakeClock();
    const s = seed();
    const early = joinEpisode({ ...s, deadlineAt: 20_000 });
    const late = joinEpisode({ ...s, deadlineAt: 270_000 });
    expect(early.episodeId).toBe(late.episodeId);
    const id = early.episodeId;

    // Round 1: both park, both wake.
    const r1 = Promise.all([
      early.waitForNextAttempt(never(), 5_000),
      late.waitForNextAttempt(never(), 5_000),
    ]);
    await drain();
    await clock.advance(5_000);
    await r1;
    early.recordAttemptResult("ConnectionRefused", false);
    late.recordAttemptResult("ConnectionRefused", false);

    // `early` now runs out of budget: it declares a handoff and leaves.
    early.handoff();
    early.leave();

    // THE EPISODE IS STILL ALIVE and still has the other waiter.
    const after = describeEpisode(id);
    expect(after).not.toBeNull();
    expect(after?.waiters).toBe(1);
    // `state` describes the retry LOOP, not the departed waiter.
    expect(after?.state).not.toBe("handoff");

    // And `late` still gets its scheduled attempts.
    let lateWoke = false;
    const r2 = late.waitForNextAttempt(never(), 10_000).then((o) => {
      lateWoke = o.kind === "attempt";
    });
    await drain();
    expect(clock.pending()).toBe(1);
    await clock.advance(10_000);
    await r2;
    expect(lateWoke).toBe(true);

    late.leave();
  });

  test("the episode enters handoff only when the LAST waiter has left by deadline", async () => {
    useFakeClock();
    const s = seed();
    const a = joinEpisode({ ...s, deadlineAt: 20_000 });
    const b = joinEpisode({ ...s, deadlineAt: 40_000 });
    const id = a.episodeId;

    a.handoff();
    a.leave();
    expect(describeEpisode(id)?.state).not.toBe("handoff");

    b.handoff();
    b.leave();
    expect(describeEpisode(id)?.state).toBe("handoff");
    // The grace timer is armed AND unref'd — it outlives the request that
    // created it and must never be the reason the process refuses to exit.
    expect(clock.pendingAt()).toEqual([EPISODE_GRACE_MS]);
    expect(clock.unrefed.size).toBe(1);
  });

  test("a handoff waiter leaving does NOT clear the shared attempt timer", async () => {
    useFakeClock();
    const s = seed();
    const early = joinEpisode({ ...s, deadlineAt: 20_000 });
    const late = joinEpisode({ ...s, deadlineAt: 270_000 });

    const parked = late.waitForNextAttempt(never(), 30_000);
    await drain();
    expect(clock.pending()).toBe(1);

    early.handoff();
    early.leave();
    // Still armed. Clearing it here is exactly how the previous revision
    // stranded the remaining waiters.
    expect(clock.pending()).toBe(1);

    await clock.advance(30_000);
    expect((await parked).kind).toBe("attempt");
    late.leave();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The Observer leak
// ───────────────────────────────────────────────────────────────────────────

describe("no Observer leak: the waiter set empties and listeners detach", () => {
  test("an aborted wait rejects, empties the set and releases the episode at once", async () => {
    useFakeClock();
    const ac = new AbortController();
    const { signal, counts } = countingSignal(ac);
    const h = joinEpisode(seed());
    const id = h.episodeId;

    const parked = h.waitForNextAttempt(signal, 60_000);
    await drain();
    expect(describeEpisode(id)?.waiters).toBe(1);
    expect(counts.added).toBe(1);

    ac.abort(new DOMException("client gone", "AbortError"));
    await expect(parked).rejects.toThrow();

    // The caller's `finally`.
    h.leave();

    // The set is empty, the timer is gone, and the episode is RELEASED —
    // no 120 s grace, because the grace is for a deliberate tier-2 handoff
    // and not a general retention policy.
    expect(describeEpisode(id)).toBeNull();
    expect(episodeCount()).toBe(0);
    expect(clock.pending()).toBe(0);
    // The listener came off. Every indirect proxy for this (episode count,
    // timer count) is also true of an implementation that leaks it.
    expect(counts.removed).toBeGreaterThanOrEqual(counts.added);
  });

  test("a NORMALLY woken waiter also detaches its abort listener", async () => {
    useFakeClock();
    const ac = new AbortController();
    const { signal, counts } = countingSignal(ac);
    const h = joinEpisode(seed());

    const parked = h.waitForNextAttempt(signal, 5_000);
    await drain();
    expect(counts.added).toBe(1);
    await clock.advance(5_000);
    expect((await parked).kind).toBe("attempt");
    // Detached on the WAKE path, not only on the abort path — otherwise every
    // rung of a long ladder adds another listener to the client's signal.
    expect(counts.removed).toBe(1);
    h.leave();
  });

  test("leave() is idempotent — it is called from a `finally` that can run twice", () => {
    useFakeClock();
    const h = joinEpisode(seed());
    const id = h.episodeId;
    h.leave();
    h.leave();
    h.leave();
    expect(describeEpisode(id)).toBeNull();
    expect(episodeCount()).toBe(0);
  });

  test("an already-aborted signal rejects without ever arming a timer", async () => {
    useFakeClock();
    const ac = new AbortController();
    ac.abort(new DOMException("gone", "AbortError"));
    const h = joinEpisode(seed());
    await expect(h.waitForNextAttempt(ac.signal, 5_000)).rejects.toThrow();
    expect(clock.pending()).toBe(0);
    h.leave();
  });

  test("closeAllEpisodes wakes every parked waiter rather than stranding it", async () => {
    useFakeClock();
    const h = joinEpisode(seed());
    const parked = h.waitForNextAttempt(never(), 60_000);
    await drain();
    closeAllEpisodes("shutdown");
    // The timer has just been cleared; without the explicit wake this promise
    // could never settle and the process would hang on shutdown.
    expect((await parked).kind).toBe("gave_up");
    expect(episodeCount()).toBe(0);
    h.leave();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Rejoining inside the grace window
// ───────────────────────────────────────────────────────────────────────────

describe("an episode rejoined within EPISODE_GRACE_MS continues", () => {
  test("same episode id, ladder position carried forward, clientRetries++", async () => {
    useFakeClock();
    const s = seed();
    const first = joinEpisode(s);
    const id = first.episodeId;

    // Walk the ladder up three rungs.
    for (let i = 0; i < 3; i++) {
      first.recordAttemptResult("ConnectionRefused", false);
      const p = first.waitForNextAttempt(never(), 5_000);
      await drain();
      await clock.advance(5_000);
      await p;
    }
    first.recordAttemptResult("ConnectionRefused", false);
    const ladderAtHandoff = first.ladderIndex();
    const attemptsAtHandoff = first.attempts();
    expect(ladderAtHandoff).toBeGreaterThan(0);

    first.handoff();
    first.leave();
    expect(describeEpisode(id)?.state).toBe("handoff");

    // The client comes back inside the grace window.
    await clock.advance(EPISODE_GRACE_MS - 1_000);
    const second = joinEpisode(s);

    expect(second.episodeId).toBe(id);
    // The ladder does NOT reset. The target has been down for the whole of it,
    // and starting again at 5 s would hammer a dead host harder the longer the
    // outage lasted.
    expect(second.ladderIndex()).toBe(ladderAtHandoff);
    expect(second.attempts()).toBe(attemptsAtHandoff);
    expect(describeEpisode(id)?.clientRetries).toBe(1);
    expect(describeEpisode(id)?.maxTier).toBe(2);
    expect(describeEpisode(id)?.state).toBe("attempting");
    // The grace timer was cancelled on rejoin, not left to fire later.
    expect(clock.pending()).toBe(0);
    second.leave();
  });

  test("past the grace window the episode is gone and a NEW one is minted", async () => {
    useFakeClock();
    const s = seed();
    const first = joinEpisode(s);
    const id = first.episodeId;
    first.recordAttemptResult("ConnectionRefused", false);
    first.handoff();
    first.leave();
    expect(describeEpisode(id)?.state).toBe("handoff");

    await clock.advance(EPISODE_GRACE_MS + 1);
    expect(describeEpisode(id)).toBeNull();

    const second = joinEpisode(s);
    expect(second.episodeId).not.toBe(id);
    expect(second.ladderIndex()).toBe(0);
    expect(second.attempts()).toBe(0);
    second.leave();
  });

  test("EPISODE_GRACE_MS is the measured 120 s, not a guess", () => {
    // Claude Code's own post-503 backoff was measured to cap at ~38.4 s, so
    // this is 3.1x the worst observed rejoin gap.
    expect(EPISODE_GRACE_MS).toBe(120_000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4b. The OTHER way a handoff ends: the client's own retry simply succeeds
// ───────────────────────────────────────────────────────────────────────────

describe("noteTargetReachable — the handoff that ends without a rejoin", () => {
  test("a reachable target closes the parked episode as recovered", async () => {
    useFakeClock();
    const s = seed({ providerName: "reach-1" });
    const h = joinEpisode(s);
    const id = h.episodeId;
    h.recordAttemptResult("ConnectionRefused", false);
    h.handoff();
    h.leave();
    expect(describeEpisode(id)?.state).toBe("handoff");

    // Tier 2's rejoin is NOT what happens when the network comes back. The
    // client's re-POST enters the handler's byte-identical primary fetch, which
    // succeeds outright — no catch, no `joinEpisode`. Without this call the
    // episode would sit here for the rest of its 120-second grace with the pane
    // painting "waiting for Claude Code to retry" over a working session.
    noteTargetReachable("reach-1", "http://127.0.0.1:9/v1/chat/completions");

    expect(describeEpisode(id)).toBeNull();
    expect(episodeCount()).toBe(0);
  });

  test("ANOTHER HOST of the same provider closes it — an auth episode is still this outage", async () => {
    // The episode key is `provider|host` and the AUTH sites seed the host from
    // the error, so a `gk@` outage during a token refresh opens an episode on
    // `auth.x.ai` while `noteTargetReachable` is called with the MODEL endpoint.
    // A strict key lookup missed it, and the pane went on painting "waiting for
    // Claude Code to retry" over a working session for the full 120-second
    // grace — the fix that shipped for the fetch path, absent for the five auth
    // sites.
    //
    // Closing by provider is sound rather than convenient: a request that
    // reached the model endpoint had to authenticate first, so it has just
    // proved every host it touched is answering.
    useFakeClock();
    const auth = joinEpisode(
      seed({ providerName: "reach-2", endpoint: "https://auth.example.com/oauth2/token" })
    );
    auth.recordAttemptResult("ConnectionRefused", false);
    auth.handoff();
    auth.leave();
    expect(describeEpisode(auth.episodeId)?.state).toBe("handoff");

    noteTargetReachable("reach-2", "https://api.example.com/v1/chat/completions");
    expect(describeEpisode(auth.episodeId)).toBeNull();
  });

  test("a DIFFERENT PROVIDER never closes it — one provider's success says nothing", async () => {
    useFakeClock();
    const h = joinEpisode(seed({ providerName: "reach-2b" }));
    h.recordAttemptResult("ConnectionRefused", false);
    h.handoff();
    h.leave();

    noteTargetReachable("other-provider", "http://127.0.0.1:9/v1/chat/completions");
    expect(describeEpisode(h.episodeId)?.state).toBe("handoff");
  });

  test("a LIVE episode with parked waiters is never closed underneath them", async () => {
    useFakeClock();
    const s = seed({ providerName: "reach-3" });
    const h = joinEpisode(s);
    h.recordAttemptResult("ConnectionRefused", false);
    const woken: WaitOutcome[] = [];
    const parked = h.waitForNextAttempt(never(), 30_000).then((o) => {
      woken.push(o);
    });
    await drain();

    // One request's success says nothing about another's. Closing here would
    // wake this waiter with `gave_up` and answer an inline error for an outage
    // that its own ladder was still working on.
    noteTargetReachable("reach-3", "http://127.0.0.1:9/v1/chat/completions");

    expect(describeEpisode(h.episodeId)?.state).toBe("waiting");
    expect(woken).toHaveLength(0);

    await clock.advance(30_000);
    await parked;
    expect(woken).toEqual([{ kind: "attempt" }]);
    h.leave();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Success, and the seams that are deliberately inert in this phase
// ───────────────────────────────────────────────────────────────────────────

describe("a successful attempt", () => {
  test("resets the ladder and wakes the other waiters instead of stranding them", async () => {
    useFakeClock();
    const s = seed();
    const a = joinEpisode(s);
    const b = joinEpisode(s);

    a.recordAttemptResult("ConnectionRefused", false);
    const p1 = Promise.all([
      a.waitForNextAttempt(never(), 5_000),
      b.waitForNextAttempt(never(), 5_000),
    ]);
    await drain();
    await clock.advance(5_000);
    await p1;
    a.recordAttemptResult("ConnectionRefused", false);
    expect(a.ladderIndex()).toBe(1);

    // b parks again; a succeeds while b is parked.
    const bWoke: WaitOutcome["kind"][] = [];
    const pb = b.waitForNextAttempt(never(), 10_000).then((o) => {
      bWoke.push(o.kind);
    });
    await drain();
    expect(clock.pending()).toBe(1);

    a.recordAttemptResult("ok", true);
    await drain();

    // The host answered a second ago: it has not earned a sixty-second gap.
    expect(a.ladderIndex()).toBe(0);
    // And b was woken rather than left on a timer that has just been cleared.
    await pb;
    expect(bWoke).toEqual(["attempt"]);
    expect(clock.pending()).toBe(0);

    a.leave();
    b.leave();
  });

  test("the episode closes `recovered` when the last waiter leaves after a success", () => {
    useFakeClock();
    const h = joinEpisode(seed());
    const id = h.episodeId;
    h.recordAttemptResult("ConnectionRefused", false);
    h.recordAttemptResult("ok", true);
    h.leave();
    expect(describeEpisode(id)).toBeNull();
    expect(episodeCount()).toBe(0);
  });
});

describe("ending an episode from outside the ladder", () => {
  test("giveUp wakes every waiter with gave_up and latches", async () => {
    useFakeClock();
    const s = seed();
    const a = joinEpisode(s);
    const b = joinEpisode(s);
    const pa = a.waitForNextAttempt(never(), 60_000);
    const pb = b.waitForNextAttempt(never(), 60_000);
    await drain();

    giveUp(a.episodeId);
    expect((await pa).kind).toBe("gave_up");
    expect((await pb).kind).toBe("gave_up");
    // Latched: a waiter parking after [q] must not be parked again.
    expect((await a.waitForNextAttempt(never(), 60_000)).kind).toBe("gave_up");
    a.leave();
    b.leave();
  });

  test("uiLeaseValid is inert in this phase and answers false", () => {
    useFakeClock();
    const h = joinEpisode(seed());
    // There is no socket, no pane and no heartbeat yet, so the honest answer is
    // false and the exhaustion arm keeps answering today's 400. A `true` here
    // would ship the design's own stated worst case: a retryable status with no
    // surface on which the reason is legible.
    expect(uiLeaseValid(h.episodeId)).toBe(false);
    expect(h.uiLeaseValid()).toBe(false);
    h.leave();
  });
});
