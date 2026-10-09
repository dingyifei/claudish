/**
 * The recovery coordinator — one EPISODE per unreachable target, shared by
 * every request that is failing against it.
 *
 * WHY A COORDINATOR AND NOT N INDEPENDENT LADDERS. Claude Code issues
 * concurrent requests: the main loop, the small title/summary model, and every
 * subagent. During an outage all of them fail within milliseconds of each
 * other. Give each its own ladder and you get N times the connect attempts
 * against a dead network, N unsynchronised countdowns, and no single number a
 * banner could ever show. With one episode there is one timer per target, every
 * parked request wakes together, and each still re-issues ITS OWN bytes —
 * which matters, because they are different requests and the body was
 * serialized per request.
 *
 * THREE LIFETIMES LIVE HERE AND THEY ARE NOT THE SAME OBJECT. This is the
 * distinction the design got wrong once and it is worth restating:
 *
 *   - the DEADLINE belongs to one inbound request. Its owner is the waiter.
 *     A waiter past its own deadline answers for itself and leaves.
 *   - the LADDER belongs to the episode. It ends when the last waiter leaves
 *     or an attempt succeeds — never because one waiter ran out of time.
 *   - the PANE LEASE belongs to a renderer painting this episode. It is granted
 *     and revoked in `magmux-ui.ts`, which registers itself here; this file
 *     only ever ASKS, via `uiLeaseValid`, and never caches the answer.
 *
 * Letting one field mean all three is what made a four-waiter episode show
 * `waiters: 4` while exactly one of them was still being retried.
 */

import { randomUUID } from "node:crypto";
import { type ConnectionErrorKind, isLoopback } from "../handlers/shared/connection-error.js";
import { log, logRecovery } from "../logger.js";
import { recoveryClock } from "./clock.js";
import type { RecoveryEpisodeFrame, RecoveryFrameState } from "./types.js";

export type RecoveryState = "attempting" | "waiting" | "recovered" | "handoff" | "abandoned";

export type RecoveryOutcome =
  | "recovered"
  | "handoff"
  | "client_gone"
  | "gave_up"
  | "grace_expired"
  | "shutdown";

/** What a parked waiter is woken with. An abort REJECTS instead. */
export type WaitOutcome = { kind: "attempt" } | { kind: "gave_up" };

/**
 * How long a handed-off episode stays open waiting for the client to come back.
 *
 * Sized against a measurement, not a guess: Claude Code's own backoff after a
 * 503 doubles off ~0.5 s and CAPS at ~38.4 s, so 120 s is 3.1× the worst
 * observed rejoin gap.
 *
 * Defined here rather than beside the backoff ladder because it is EPISODE
 * state, and keeping it here is what lets this module stay free of any import
 * from `transient-retry.ts` — the ladder's own delays are handed IN by the
 * caller for exactly the same reason. One-way dependency, no cycle.
 */
export const EPISODE_GRACE_MS = 120_000;

export interface EpisodeSeed {
  providerName: string;
  providerDisplayName: string;
  /** The endpoint that actually failed — the AUTH host on an auth-path failure. */
  endpoint: string;
  kind: ConnectionErrorKind;
  code: string | null;
  /** The same sentence the immediate 400 would have carried. */
  reason: string;
  /** This waiter's own absolute deadline, PROCESS ms. */
  deadlineAt: number;
}

interface Waiter {
  deadlineAt: number;
  /** Non-null exactly while this waiter is parked. */
  wake: ((outcome: WaitOutcome) => void) | null;
  fail: ((err: unknown) => void) | null;
  /** Detach the abort listener. Always called; an Observer leak is the named risk. */
  detach: (() => void) | null;
}

interface Episode {
  episodeId: string;
  key: string;
  providerDisplayName: string;
  endpoint: string;
  host: string;
  kind: ConnectionErrorKind;
  loopback: boolean;
  code: string | null;
  reason: string;
  state: RecoveryState;
  startedAtPerf: number;
  startedAtMs: number;
  /**
   * Set when a pane is first ASKED for — including when the answer is an
   * immediate no, because asking and being told no is still asking. Null on
   * every surface that cannot open one at all.
   */
  paneRequestedAtPerf: number | null;
  ladderIndex: number;
  attempts: number;
  clientRetries: number;
  /** Ladder rounds, so N concurrent waiters advance the ladder ONCE per round. */
  round: number;
  advancedForRound: number;
  /** How many attempts in this episode have SUCCEEDED. */
  recoveredCount: number;
  lastOutcome: string;
  maxTier: 1 | 2;
  waiters: Set<Waiter>;
  attemptTimer: unknown | null;
  graceTimer: unknown | null;
  nextAttemptAtPerf: number | null;
  /** True once ANY waiter has left because IT ran out of budget. */
  anyLeftByDeadline: boolean;
  gaveUp: boolean;
}

const episodes = new Map<string, Episode>();
const byId = new Map<string, Episode>();

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

/** Exported for tests and for `shutdown()`; not part of the waiter contract. */
export function episodeCount(): number {
  return episodes.size;
}

/** Snapshot for logs and tests. Never mutate the returned object. */
export function describeEpisode(episodeId: string): Readonly<Record<string, unknown>> | null {
  const ep = byId.get(episodeId);
  if (!ep) return null;
  return {
    episodeId: ep.episodeId,
    key: ep.key,
    state: ep.state,
    ladderIndex: ep.ladderIndex,
    attempts: ep.attempts,
    round: ep.round,
    clientRetries: ep.clientRetries,
    waiters: ep.waiters.size,
    maxTier: ep.maxTier,
    lastOutcome: ep.lastOutcome,
    nextAttemptAtPerf: ep.nextAttemptAtPerf,
    paneRequestedAtPerf: ep.paneRequestedAtPerf,
  };
}

/**
 * What the UI manager (`magmux-ui.ts`) plugs into the coordinator.
 *
 * A REGISTRATION SEAM RATHER THAN AN IMPORT, and not for testability. The UI
 * manager reads episode state to build the banner, so it must import this
 * module; a direct import back the other way is a cycle. More importantly it
 * keeps the dependency HONEST in the other direction: nothing is installed in
 * `-p`, in `serve`, in the MCP server or in the test suite, so those paths
 * cannot draw a banner, cannot hold a lease, and behave exactly as they did
 * before this feature — by construction rather than by a flag someone has to
 * remember to check.
 */
export interface RecoveryUiHooks {
  /** A new episode exists. The manager starts drawing the banner. */
  onEpisodeOpened(episodeId: string): void;
  /**
   * An episode reached a terminal state. `attempts` is the FINAL count, the
   * winning attempt included; the last frame the banner drew predates it.
   */
  onEpisodeClosed(episodeId: string, outcome: RecoveryOutcome, attempts: number): void;
  /** Is a renderer painting this episode RIGHT NOW? */
  leaseValid(episodeId: string): boolean;
}

let uiHooks: RecoveryUiHooks | null = null;

/** Install (or, with null, remove) the recovery UI. Process-scoped. */
export function registerRecoveryUi(hooks: RecoveryUiHooks | null): void {
  uiHooks = hooks;
}

/**
 * Is a renderer currently painting this episode?
 *
 * A FUNCTION AND NOT A FIELD, because the answer is LIVE. A lease read once and
 * cached into a boolean is already stale by the time a status is chosen from
 * it — which is precisely how the superseded `uiAttached` latch could report a
 * banner that had been killed, closed or frozen minutes earlier.
 *
 * FALSE whenever no UI is installed, which is every non-interactive surface.
 */
export function uiLeaseValid(episodeId: string): boolean {
  if (!uiHooks) return false;
  try {
    return uiHooks.leaseValid(episodeId);
  } catch {
    // A throwing lease probe must read as "no surface", never as "yes". The
    // asymmetry is the point: false costs a legible inline error, true costs
    // the turn.
    return false;
  }
}

/** Record that a banner was ASKED for. Asking and being told no is still asking. */
export function markPaneRequested(episodeId: string): void {
  const ep = byId.get(episodeId);
  if (!ep || ep.paneRequestedAtPerf !== null) return;
  ep.paneRequestedAtPerf = recoveryClock().now();
}

/** Live episodes, most waiters first, tie-broken by earliest start. */
function liveEpisodes(): Episode[] {
  const live = [...episodes.values()].filter(
    (e) => e.state === "attempting" || e.state === "waiting" || e.state === "handoff"
  );
  live.sort((a, b) => b.waiters.size - a.waiters.size || a.startedAtMs - b.startedAtMs);
  return live;
}

/**
 * The episode the banner should draw, as a frame — or null.
 *
 * Concurrent episodes are ORDINARY: the main loop's provider and the small
 * title model's provider can be unreachable at the same moment. Which one wins
 * is not load-bearing, because the lease is per-episode — a non-rendered
 * episode simply holds no lease, and at exhaustion answers the inline error,
 * which is exactly what "a retryable status is permissible only while the
 * reason is legible" demands.
 *
 * THE UNIT CONVERSION HAPPENS HERE AND NOWHERE ELSE. Intervals inside this
 * module are process ms; every instant in a frame is epoch ms, so the banner's
 * countdown is computed against `Date.now()` in one unit, with no second
 * conversion site to drift.
 */
export function renderableEpisodeFrame(): RecoveryEpisodeFrame | null {
  const live = liveEpisodes();
  const ep = live[0];
  if (!ep) return null;
  const clock = recoveryClock();
  const perfNow = clock.now();
  const epochNow = Date.now();
  const nextAttemptAtMs =
    ep.nextAttemptAtPerf === null ? null : epochNow + (ep.nextAttemptAtPerf - perfNow);
  return {
    type: "episode",
    episodeId: ep.episodeId,
    state: ep.state as RecoveryFrameState,
    tier: ep.maxTier,
    providerDisplayName: ep.providerDisplayName,
    host: ep.host,
    endpoint: ep.endpoint,
    kind: ep.kind,
    code: ep.code,
    loopback: ep.loopback,
    reason: ep.reason,
    attempts: ep.attempts,
    clientRetries: ep.clientRetries,
    startedAtMs: ep.startedAtMs,
    nextAttemptAtMs,
    lastOutcome: ep.lastOutcome,
    waiters: ep.waiters.size,
    otherEpisodes: live.length - 1,
  };
}

export interface EpisodeHandle {
  readonly episodeId: string;
  readonly key: string;
  /** Total attempts this EPISODE has made, across every waiter and both tiers. */
  attempts(): number;
  /** Ms since the episode opened — not since this request started. */
  recoveryMs(): number;
  /**
   * How many times a client has re-entered this episode after a tier-2
   * handoff. 0 for the request that opened it.
   *
   * Read for stats, so that a record can say WHICH re-entry it was rather than
   * leaving five records of one outage indistinguishable from five outages.
   */
  clientRetries(): number;
  ladderIndex(): number;
  /** LIVE. Never cache the result. */
  uiLeaseValid(): boolean;
  /**
   * Park until the next attempt is due. Resolves `{kind:"attempt"}` on the
   * shared timer, `{kind:"gave_up"}` if the user asked to stop, and REJECTS
   * with the signal's abort reason if the client goes away.
   *
   * `delayMs` is the caller's reading of the ladder at `ladderIndex()`. It is
   * used only by the FIRST waiter to park in a round — the timer is shared, so
   * a second waiter joining an armed round inherits the gap already running
   * rather than restarting it. That is the whole point of one episode.
   */
  waitForNextAttempt(signal: AbortSignal, delayMs: number): Promise<WaitOutcome>;
  recordAttemptResult(outcome: string, ok: boolean): void;
  /**
   * THIS waiter ran out of budget. It does not move the episode: the episode
   * enters `handoff` only when the LAST waiter has left and at least one of
   * them left this way — a property of the SET, computed on the final leave.
   */
  handoff(): void;
  close(outcome: RecoveryOutcome): void;
  /** MUST be called in a `finally`. */
  leave(): void;
}

/**
 * Join the episode for this target, creating it if this is the first failure.
 *
 * A request arriving while an episode is in `handoff` REJOINS it — same
 * `episodeId`, same ladder position, `clientRetries` incremented — which is
 * what makes an in-request hold and a client-side retry read as one continuous
 * recovery rather than as two unrelated failures.
 */
export function joinEpisode(seed: EpisodeSeed): EpisodeHandle {
  const clock = recoveryClock();
  const host = hostOf(seed.endpoint);
  const key = `${seed.providerName}|${host}`;

  let ep = episodes.get(key);

  if (ep && (ep.state === "recovered" || ep.state === "abandoned")) {
    episodes.delete(key);
    ep = undefined;
  }

  if (ep) {
    if (ep.state === "handoff") {
      // The client came back inside the grace window: same episode, same
      // ladder, one more client retry. The ladder does NOT reset — the target
      // has been down for the whole of it and starting again at 5 s would
      // hammer a dead host harder the longer the outage lasted.
      if (ep.graceTimer !== null) {
        clock.clearTimeout(ep.graceTimer);
        ep.graceTimer = null;
      }
      ep.clientRetries++;
      ep.state = "attempting";
      ep.maxTier = 2;
      logRecovery(
        `[Recovery] ${ep.providerDisplayName} rejoined episode ${ep.episodeId} ` +
          `(client retry ${ep.clientRetries}, ladder ${ep.ladderIndex}, attempts ${ep.attempts})`
      );
    }
  } else {
    const nowPerf = clock.now();
    ep = {
      episodeId: randomUUID(),
      key,
      providerDisplayName: seed.providerDisplayName,
      endpoint: seed.endpoint,
      host,
      kind: seed.kind,
      // Decided ONCE, at creation, from the endpoint — never from the error
      // code. On macOS an unrouted REMOTE address reports `ECONNREFUSED` after
      // 75 s, the same code a loopback port refuses in 5 ms, so the code cannot
      // tell them apart and only the address can.
      loopback: isLoopback(seed.endpoint),
      code: seed.code,
      reason: seed.reason,
      state: "attempting",
      startedAtPerf: nowPerf,
      startedAtMs: Date.now(),
      paneRequestedAtPerf: null,
      ladderIndex: 0,
      attempts: 0,
      clientRetries: 0,
      round: 0,
      // Round 0 counts as already advanced. The failure that OPENS an episode
      // is attempt 1, and attempt 1's gap is the ladder's FIRST rung (5 s) —
      // so recording it must not push the index to the second (10 s). Getting
      // this off by one turns the specified 5/10/30/60/60 into 10/30/60/60.
      advancedForRound: 0,
      recoveredCount: 0,
      lastOutcome: seed.code ?? "unknown",
      maxTier: 1,
      waiters: new Set(),
      attemptTimer: null,
      graceTimer: null,
      nextAttemptAtPerf: null,
      anyLeftByDeadline: false,
      gaveUp: false,
    };
    episodes.set(key, ep);
    byId.set(ep.episodeId, ep);
    logRecovery(
      `[Recovery] episode ${ep.episodeId} opened for ${ep.providerDisplayName} at ${ep.endpoint} ` +
        `(${ep.kind}/${ep.code ?? "?"})`
    );
    // Ask for a surface. Nothing is installed unless this process was launched
    // through the magmux wrapper, so on every other surface this is a no-op —
    // which is why `-p`, `serve` and the suite are untouched.
    if (uiHooks) {
      try {
        uiHooks.onEpisodeOpened(ep.episodeId);
      } catch (err) {
        // A UI failure must never break recovery. The banner is what EARNS the
        // wait; it is not what performs it.
        log(`[Recovery] UI could not open for episode ${ep.episodeId}: ${String(err)}`);
      }
    }
  }

  const episode = ep;
  const waiter: Waiter = {
    deadlineAt: seed.deadlineAt,
    wake: null,
    fail: null,
    detach: null,
  };
  episode.waiters.add(waiter);

  let left = false;

  return {
    episodeId: episode.episodeId,
    key: episode.key,
    attempts: () => episode.attempts,
    recoveryMs: () => Math.round(recoveryClock().now() - episode.startedAtPerf),
    clientRetries: () => episode.clientRetries,
    ladderIndex: () => episode.ladderIndex,
    uiLeaseValid: () => uiLeaseValid(episode.episodeId),

    waitForNextAttempt(signal: AbortSignal, delayMs: number): Promise<WaitOutcome> {
      if (episode.gaveUp || episode.state === "abandoned") {
        return Promise.resolve({ kind: "gave_up" });
      }
      if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));

      return new Promise<WaitOutcome>((resolve, reject) => {
        const onAbort = () => {
          waiter.wake = null;
          waiter.fail = null;
          waiter.detach = null;
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason ?? new Error("aborted"));
        };
        // Unsubscribe is not optional. A parked waiter that leaves without
        // detaching keeps this closure — and the whole episode — alive for as
        // long as the client signal exists.
        waiter.detach = () => signal.removeEventListener("abort", onAbort);
        waiter.wake = (outcome) => {
          waiter.detach?.();
          waiter.detach = null;
          waiter.wake = null;
          waiter.fail = null;
          resolve(outcome);
        };
        waiter.fail = (err) => {
          waiter.detach?.();
          waiter.detach = null;
          waiter.wake = null;
          waiter.fail = null;
          reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        armAttemptTimer(episode, delayMs);
      });
    },

    recordAttemptResult(outcome: string, ok: boolean): void {
      episode.attempts++;
      episode.lastOutcome = outcome;
      if (ok) {
        // The target just proved reachable. The episode is NOT torn down here:
        // other waiters may still be parked on the shared timer, and closing
        // it from under them clears that timer and strands them forever with
        // nothing to wake them. Wake them instead, and reset the ladder — a
        // host that answered a second ago has not earned a sixty-second gap.
        // The episode's own end is decided by the LAST waiter to leave.
        episode.recoveredCount++;
        episode.ladderIndex = 0;
        episode.advancedForRound = episode.round;
        episode.state = "attempting";
        clearAttemptTimer(episode);
        for (const w of [...episode.waiters]) w.wake?.({ kind: "attempt" });
        return;
      }
      // Advance the ladder ONCE per round however many waiters attempted it.
      if (episode.advancedForRound !== episode.round) {
        episode.advancedForRound = episode.round;
        episode.ladderIndex++;
      }
      logRecovery(
        `[Recovery] ${episode.providerDisplayName} attempt ${episode.attempts} failed: ${outcome} ` +
          `(episode ${episode.episodeId}, ladder ${episode.ladderIndex})`
      );
    },

    handoff(): void {
      // EPISODE-level only. A per-waiter copy of this was write-only, and the
      // decision it feeds — what the LAST waiter out closes the episode as —
      // is an episode-level question by construction.
      episode.anyLeftByDeadline = true;
    },

    close(outcome: RecoveryOutcome): void {
      closeEpisode(episode, outcome);
    },

    leave(): void {
      if (left) return;
      left = true;
      waiter.detach?.();
      waiter.detach = null;
      waiter.wake = null;
      waiter.fail = null;
      episode.waiters.delete(waiter);
      if (episode.waiters.size > 0) return;

      // Last one out.
      clearAttemptTimer(episode);
      if (episode.state === "recovered" || episode.state === "abandoned") {
        byId.delete(episode.episodeId);
        return;
      }

      if (episode.recoveredCount > 0 && !episode.anyLeftByDeadline) {
        closeEpisode(episode, "recovered");
      } else if (episode.anyLeftByDeadline) {
        // A DELIBERATE handoff: a re-POST is expected, so hold the counters.
        episode.state = "handoff";
        const c = recoveryClock();
        const timer = c.setTimeout(() => {
          episode.graceTimer = null;
          closeEpisode(episode, "grace_expired");
        }, EPISODE_GRACE_MS);
        c.unref?.(timer);
        episode.graceTimer = timer;
        logRecovery(
          `[Recovery] episode ${episode.episodeId} handed off after ${Math.round(
            c.now() - episode.startedAtPerf
          )}ms, ${episode.attempts} attempts — holding ${EPISODE_GRACE_MS / 1000}s for a client retry`
        );
      } else {
        // The client went away. The grace is for a handoff, not a general
        // retention policy: release now.
        closeEpisode(episode, "client_gone");
      }
    },
  };
}

function armAttemptTimer(episode: Episode, delay: number): void {
  if (episode.attemptTimer !== null) return;
  const clock = recoveryClock();
  episode.state = "waiting";
  episode.nextAttemptAtPerf = clock.now() + delay;
  episode.attemptTimer = clock.setTimeout(() => {
    episode.attemptTimer = null;
    episode.nextAttemptAtPerf = null;
    episode.state = "attempting";
    episode.round++;
    for (const w of [...episode.waiters]) w.wake?.({ kind: "attempt" });
  }, delay);
  logRecovery(
    `[Recovery] ${episode.providerDisplayName} waiting ${delay / 1000}s before attempt ` +
      `${episode.attempts + 1} (episode ${episode.episodeId}, ${episode.waiters.size} waiting)`
  );
}

function clearAttemptTimer(episode: Episode): void {
  if (episode.attemptTimer === null) return;
  recoveryClock().clearTimeout(episode.attemptTimer);
  episode.attemptTimer = null;
  episode.nextAttemptAtPerf = null;
}

function closeEpisode(episode: Episode, outcome: RecoveryOutcome): void {
  if (episode.state === "recovered" || episode.state === "abandoned") return;
  const clock = recoveryClock();
  clearAttemptTimer(episode);
  if (episode.graceTimer !== null) {
    clock.clearTimeout(episode.graceTimer);
    episode.graceTimer = null;
  }
  episode.state = outcome === "recovered" ? "recovered" : "abandoned";
  if (episodes.get(episode.key) === episode) episodes.delete(episode.key);
  byId.delete(episode.episodeId);
  // Never strand a parked waiter. Shutdown and give-up both reach here with
  // waiters still on the shared timer, and the timer has just been cleared —
  // without this they would wait on a promise nothing can ever settle.
  if (episode.state === "abandoned") {
    for (const w of [...episode.waiters]) w.wake?.({ kind: "gave_up" });
  }
  logRecovery(
    `[Recovery] episode ${episode.episodeId} closed: ${outcome} after ` +
      `${Math.round(clock.now() - episode.startedAtPerf)}ms and ${episode.attempts} attempts`
  );
  if (uiHooks) {
    try {
      uiHooks.onEpisodeClosed(episode.episodeId, outcome, episode.attempts);
    } catch {
      /* see onEpisodeOpened — the UI never breaks recovery */
    }
  }
}

/**
 * A request reached this target WITHOUT the ladder's help. Close any episode
 * parked in `handoff` for it.
 *
 * ── THE CASE THIS EXISTS FOR, WHICH THE DESIGN DID NOT ANTICIPATE ───────────
 *
 * Tier 2 hands the retry back as a 503 and leaves the episode `handoff` for its
 * grace window. Claude Code's backoff elapses and it re-POSTs — and the
 * re-POST's FIRST attempt is the handler's byte-identical primary fetch, which
 * runs BEFORE the coordinator ever sees the request. When the network has come
 * back in the meantime, that attempt simply SUCCEEDS: no `catch`, no
 * `joinEpisode`, no rejoin. The turn completes, and the episode sits in
 * `handoff` until its 120-second grace expires.
 *
 * That leaves the pane painting *"waiting for Claude Code to retry"* over a
 * session that is already working — for up to two minutes, on the one surface
 * whose legibility is what earns the 503 its retryable status in the first
 * place. A banner that lies is worse than no banner, because the next real
 * outage is read as more of the same.
 *
 * ── WHY THE HEALTHY PATH CAN AFFORD TO ASK ──────────────────────────────────
 *
 * The caller guards this with `episodeCount() > 0`, which is one `Map.size`
 * read. On a machine that has never had an outage the map is empty and nothing
 * below runs — no URL parse, no string build. That is the whole cost NFR-1
 * pays for the banner telling the truth.
 *
 * ONLY `handoff` is closed, and the restriction is load-bearing: an episode in
 * `attempting`/`waiting` still has parked waiters whose ladder this is, and
 * closing it underneath them would strand or gave-up requests that another
 * request's success says nothing about. A `handoff` episode has no waiters by
 * construction — that is what `handoff` means.
 *
 * ── WHY IT CLOSES BY PROVIDER AND NOT BY HOST ───────────────────────────────
 *
 * The key is `provider|host`, and the AUTH sites seed the host from the error —
 * so a `gk@` outage during a token refresh can open an episode keyed on
 * `auth.x.ai` while this function is called with the MODEL endpoint. Keyed
 * lookup missed it by host, and the fix that shipped for the fetch path was
 * absent for the five auth sites `network-recovery.md` §5 enumerates: the pane
 * went on painting "waiting for Claude Code to retry" over a working session
 * for the full 120-second grace.
 *
 * Closing every `handoff` episode for the provider is sound rather than merely
 * convenient: a request that reached the model endpoint HAD to authenticate
 * first, so it has just proved every host it touched is answering. And a
 * `handoff` episode holds no waiters, so nothing is closed out from under
 * anyone either way.
 */
export function noteTargetReachable(providerName: string, endpoint: string): void {
  const exact = `${providerName}|${hostOf(endpoint)}`;
  const prefix = `${providerName}|`;
  for (const [key, ep] of [...episodes]) {
    if (key !== exact && !key.startsWith(prefix)) continue;
    if (ep.state !== "handoff") continue;
    logRecovery(
      `[Recovery] ${ep.providerDisplayName} answered on the client's own retry — ` +
        `closing episode ${ep.episodeId} instead of waiting out its grace`
    );
    closeEpisode(ep, "recovered");
  }
}

/**
 * Is this episode still live? The coordinator is the one source of truth.
 *
 * The banner asks this AFTER its overlay write is acknowledged, not before: a
 * reply can arrive after the episode it painted has already closed, and
 * renewing that lease would report a banner for 10 s that the close had
 * already cleared. Measured by a black-box test; the lease is a money gate.
 */
export function episodeIsLive(episodeId: string): boolean {
  const ep = byId.get(episodeId);
  if (!ep) return false;
  return ep.state === "attempting" || ep.state === "waiting" || ep.state === "handoff";
}

/**
 * End ONE episode now: every waiter answers today's inline error.
 *
 * `gaveUp` latches before the close so a waiter that has not parked yet — one
 * between attempts at that instant — still reads the answer rather than
 * parking on a timer that no longer exists.
 *
 * No key reaches this since the banner became magmux's overlay, which cannot
 * read keystrokes. It stays because it is the one clean way to end an episode
 * with waiters on it, and the tests end episodes through it.
 */
export function giveUp(episodeId: string): void {
  const ep = byId.get(episodeId);
  if (!ep) return;
  ep.gaveUp = true;
  clearAttemptTimer(ep);
  closeEpisode(ep, "gave_up");
  for (const w of [...ep.waiters]) w.wake?.({ kind: "gave_up" });
}

/** Proxy shutdown: no episode may outlive the process that owns its timers. */
export function closeAllEpisodes(outcome: RecoveryOutcome = "shutdown"): void {
  for (const ep of [...episodes.values()]) closeEpisode(ep, outcome);
  for (const ep of [...byId.values()]) closeEpisode(ep, outcome);
  episodes.clear();
  byId.clear();
}
