/**
 * Tier 1 of connection recovery: re-issue a failed operation on a shared
 * episode clock, inside the request that failed, before a single byte has been
 * flushed.
 *
 * WHERE THIS LIVES AND WHY IT IS NOT A TRANSPORT WRAPPER. `enqueueRequest` and
 * `getRequestInit` are OPTIONAL on the transport interface, so a wrapper down
 * there would miss every transport implementing neither; only the handler can
 * choose the final status; and the byte-stable re-issue closure already exists
 * at the handler level, built once from the serialized body. The separating
 * rule is structural rather than stylistic: **the transports handle the
 * has-a-Response case (429 loops, model fallback); this file handles the
 * no-Response case.** They cannot overlap, because a connect failure never
 * produces a Response.
 *
 * The existing per-transport 429 loops deliberately do NOT converge here. Their
 * budgets are measured and provider-specific — one is sized at ~3 s so a config
 * TUI probe deadline is not blown, another drives a model-fallback chain off
 * observed refusal latencies — and merging them is the textbook wrong
 * abstraction.
 *
 * NOTHING IN THIS FILE RUNS ON A HEALTHY REQUEST. Every construct is built from
 * inside a `catch`, after classification has already returned non-null. That is
 * enforced by placement, not by a flag.
 */

import type { Context } from "hono";
import { log, logRecovery } from "../../logger.js";
import { recoveryClock } from "../../recovery/clock.js";
import { type EpisodeHandle, joinEpisode } from "../../recovery/coordinator.js";
import { logDeadlineIfShortened, resolveTier1DeadlineMs } from "../../recovery/settings.js";
import {
  type ConnectionErrorKind,
  buildConnectionErrorMessage,
  classifyConnectionError,
  markOwnTimeout,
} from "./connection-error.js";

export { EPISODE_GRACE_MS } from "../../recovery/coordinator.js";

/**
 * Connection backoff. Deliberately SEPARATE from `STREAM_RETRY_DELAYS_MS`:
 * those three values are load-bearing for the stream sniffer's budget and for a
 * duration quoted verbatim in a user-facing exhaustion message, and merging the
 * two schedules would couple unrelated budgets to each other.
 *
 * The last element REPEATS — the schedule is 5/10/30/60/60/… and the DEADLINE,
 * not the array, is what ends it. That inverts `STREAM_RETRY_DELAYS_MS`, where
 * the array running out IS the budget.
 */
export const CONNECTION_RETRY_DELAYS_MS = [5_000, 10_000, 30_000, 60_000] as const;

/** The gap before the attempt at `ladderIndex`. Clamped to the last element. */
export function connectionRetryDelayMs(ladderIndex: number): number {
  const i = Math.max(0, Math.min(ladderIndex, CONNECTION_RETRY_DELAYS_MS.length - 1));
  return CONNECTION_RETRY_DELAYS_MS[i] as number;
}

/**
 * Ceiling on ONE retry attempt's connect-and-headers phase. Disarmed the
 * instant `fetch()` resolves, so it can never cut a live response body.
 *
 * NOT 75 000, and the 4 ms this avoids is the whole reason. macOS's own TCP
 * connect timeout was measured at **75.004 s** against an unrouted address, so
 * a 75 000 ms cap races the operating system by four milliseconds and is
 * decided differently on different runs — which makes every assertion keyed on
 * "the attempt ended at the clamp" flaky by construction. 45 s clears the
 * collision by 30 seconds, always wins the race, and keeps the ladder
 * responsive: at the default deadline it still leaves room for the full
 * 5/10/30/60/60 sequence, because a clamped attempt only costs its own wall
 * clock when the fault is slow, and a slow fault is exactly the case where
 * waiting out 75 s per attempt would spend the entire budget on two of them.
 */
export const PER_ATTEMPT_CONNECT_CAP_MS = 45_000;

/** Below this much budget remaining, do not start another attempt. */
export const MIN_ATTEMPT_SLOT_MS = 3_000;

/**
 * Ceiling on ONE OAuth token-refresh request (Grok, Codex).
 *
 * Both refreshes sit behind a single-flight latch, because the servers ROTATE
 * the refresh token and two concurrent refreshes turn a working session into
 * `invalid_grant`. With no ceiling, a refresh on a half-open socket — the
 * network gone after the handshake — waited out the kernel's retransmit
 * timeout, minutes long. The ladder's clamp abandons an attempt, not the
 * fetch under it, so every later attempt re-entered the latch and joined the
 * same dead promise: attempts counted in the banner and the log that never
 * reached the network, and real recovery delayed until the kernel gave up.
 *
 * The ceiling bounds how long the latch can be held, which keeps the latch.
 * It is BELOW `PER_ATTEMPT_CONNECT_CAP_MS` so that a hung refresh fails inside
 * its own attempt instead of being abandoned by the clamp. Callers must tag
 * the resulting `TimeoutError` with `markOwnTimeout`: a token host that does
 * not answer in 20 s is a reachability fact, unlike an inference ceiling, and
 * left untagged it would go unclassified — which for Codex means the METERED
 * fallback.
 */
export const TOKEN_REFRESH_TIMEOUT_MS = 20_000;

/**
 * The deadline the AUTH-path catches use, deliberately earlier than the fetch
 * catch's.
 *
 * Both sit in the same request and share one `deadlineAt`. If auth recovery
 * spends all of it and then SUCCEEDS, the primary fetch that follows gets no
 * real attempt, even with the network back. So part of the budget is reserved
 * for it. (The reservation was first justified as stopping the primary fetch
 * from outliving the deadline; the request ceiling — `deadlineClamp` — now does
 * that on its own, and what is left is the fetch's right to a real attempt.)
 *
 * THE RESERVE IS CAPPED AT HALF THE BUDGET. A flat 45 s reserve against a
 * budget derived from `API_TIMEOUT_MS` left the auth path nothing at all once
 * the budget fell to 45 s (`API_TIMEOUT_MS` = 75 000) and a deadline in the
 * PAST below that — so a token refresh against a stopped server skipped
 * recovery as "no budget" and answered at once, silently. Capped at half, the
 * default is unchanged (half of 270 s is well above 45 s) and a short budget is
 * split between the two paths instead of given entirely to one.
 */
export function refreshDeadlineAt(deadlineAt: number): number {
  const reserve = Math.min(PER_ATTEMPT_CONNECT_CAP_MS, resolveTier1DeadlineMs() / 2);
  return deadlineAt - reserve;
}

/**
 * PROCESS ms at which the INBOUND request arrived — not at which this candidate
 * started.
 *
 * `handle()` mints its own `startTime` and the fallback chain calls `handle()`
 * once PER CANDIDATE, so deriving the deadline from that value gave every
 * candidate in a chain a fresh full budget and the chain as a whole could hold
 * a socket for candidates × deadline. A `WeakMap` keyed on the inbound
 * `Request` needs no route change and no context mutation (the fallback
 * handler's invariant forbids `c.set` no less than `c.header`), collects
 * itself, and is inherited by every later candidate because they share
 * `c.req.raw`.
 *
 * The residual is real and wanted: a candidate that recovers late and then
 * returns a retryable status leaves candidate 2 with only the remaining budget
 * rather than a fresh one. That is the point.
 *
 * ── THE ZERO POINT IS STAMPED BY `handle()`, NOT BY THE FIRST READER ────────
 *
 * Memoisation makes this function's value "whenever somebody first asked", and
 * on the fetch path the first asker used to be `tier1DeadlineAt(c)` inside the
 * `catch` — after attempt 1 had already failed. MEASURED against an unrouted
 * address: attempt 1 spent macOS's 75 s connect timeout, the 30 s budget then
 * started counting from t+75 s, and the client was answered at 108 s. The
 * budget had not been exceeded; it had never been applied. `handle()` now
 * stamps it on entry, which is why a caller must never assume this is cheap to
 * call late — it is only correct to call it EARLY.
 */
const INBOUND_START = new WeakMap<Request, number>();

export function inboundStartedAtPerf(c: Context): number {
  const key = c.req?.raw as Request | undefined;
  if (!key) return recoveryClock().now();
  const seen = INBOUND_START.get(key);
  if (seen !== undefined) return seen;
  const t = recoveryClock().now();
  INBOUND_START.set(key, t);
  return t;
}

/**
 * The absolute tier-1 deadline for this inbound request, PROCESS ms.
 *
 * PURE, and it has to stay pure: it is now read BEFORE the primary fetch (to
 * arm the request ceiling below), so anything it announced would be announced
 * on healthy requests too. The shortened-hold notice moved to
 * `noteDeadlineForEpisode`, which runs only once an episode really opens.
 */
export function tier1DeadlineAt(c: Context): number {
  return inboundStartedAtPerf(c) + resolveTier1DeadlineMs();
}

/**
 * Announce a hold the environment shortened — from the ladder, once per
 * process.
 *
 * Separated from `tier1DeadlineAt` because that function is now on the healthy
 * path. A user who has set `API_TIMEOUT_MS=60000` and never has an outage must
 * not be told about a hold that never happened.
 */
export function noteDeadlineForEpisode(): void {
  logDeadlineIfShortened(resolveTier1DeadlineMs());
}

/** An armed ceiling on ONE outbound call. `signal` is absent when there is none. */
export interface DeadlineClamp {
  /** Compose into the fetch init with `mergeSignalIntoInit`. */
  signal?: AbortSignal;
  /** Call the INSTANT the call settles. A live body must never be cut. */
  disarm(): void;
}

/**
 * Bound one outbound call by an ABSOLUTE deadline — the ceiling that makes the
 * derived budget authoritative for the FIRST attempt as well as for the ladder.
 *
 * ── WHY ATTEMPT 1 NEEDED A CEILING AT ALL ───────────────────────────────────
 *
 * The ladder's attempts were already clamped (`PER_ATTEMPT_CONNECT_CAP_MS`),
 * but attempt 1 — the byte-identical primary fetch — was not, on the reasoning
 * that `DEADLINE_MARGIN_MS` (30 s) reserves room for its tail. macOS's own TCP
 * connect timeout is **75 s**, so the reserve is wrong by 45 s the moment the
 * fault is a SLOW connect rather than a refusal, and it is wrong by more than
 * the entire budget whenever `API_TIMEOUT_MS ≤ 105 s`. A single connect then
 * outlived the whole request deadline and the client (which gives up at
 * `API_TIMEOUT_MS`) was gone before we answered. Every refusal-based test is
 * blind to this: a 1 ms attempt cannot cross a deadline in the middle of
 * itself.
 *
 * ── WHY THE DEADLINE AND NOT `PER_ATTEMPT_CONNECT_CAP_MS` ───────────────────
 *
 * This ceiling is on a possibly-HEALTHY call, and 45 s is a plausible
 * time-to-first-byte for a thinking model behind a long prompt. Clamping the
 * primary fetch at 45 s would convert an ordinary LATENCY event into "the host
 * is unreachable" — the exact leak past RISK-6's boundary that this design
 * already found and closed once. At the default settings this ceiling is 270 s,
 * which no provider's first byte approaches, and it shortens only as the user's
 * own `API_TIMEOUT_MS` does.
 *
 * ── AND WHY FIRING AT THE DEADLINE IS WHAT MAKES IT SAFE ────────────────────
 *
 * Because the abort lands AT `deadlineAt`, there is by construction no budget
 * left when it is classified: `shouldSkipTier1`'s `no-budget` gate fires and
 * the request answers. So this ceiling can never cause a RE-ISSUE, and cannot
 * put a slow-but-alive inference on the ladder to be billed twice. An earlier
 * firing time would not have that property — keep it absolute.
 */
export function deadlineClamp(deadlineAt: number): DeadlineClamp {
  const clock = recoveryClock();
  const remaining = deadlineAt - clock.now();
  // NaN-safe: an unparseable budget leaves the call unbounded, which is
  // pre-recovery behaviour rather than an instant abort.
  if (!(remaining > 0)) return { disarm: () => {} };
  const ac = new AbortController();
  const timer = clock.setTimeout(
    // `markOwnTimeout` is what lets this be classified at all — the discriminator
    // is the signal's ORIGIN, never the name, so a transport's own inference
    // ceiling keeps its pre-recovery route out.
    () => ac.abort(markOwnTimeout(new DOMException("request deadline", "TimeoutError"))),
    remaining
  );
  return {
    signal: ac.signal,
    disarm: () => clock.clearTimeout(timer),
  };
}

export interface ConnectionErrorInfo {
  kind: ConnectionErrorKind;
  code: string;
}

/**
 * Add an abort signal to an already-built fetch init WITHOUT discarding the
 * transport's own.
 *
 * The order is the entire point. The handler's fetch expressions spread the
 * transport's `getRequestInit()` **last**, so a signal written before that
 * spread is silently overwritten — and for a local provider the thing doing the
 * overwriting is a ten-minute `AbortSignal.timeout`. Compose rather than
 * replace: the per-attempt clamp then bounds the attempt while the transport's
 * own ceiling still applies, which is what both of them were for.
 *
 * ── AN ALREADY-FIRED `own` IS DROPPED, NOT COMPOSED ─────────────────────────
 *
 * `AbortSignal.any([fired, live])` returns a signal that is ALREADY ABORTED, so
 * the fetch rejects before it opens a socket — measured on this machine's Bun.
 * A transport's `getRequestInit()` signal is one-shot, so a caller that hoists
 * the init out of its retry loop poisons every later attempt with a ceiling
 * that expired during attempt 1: real connect attempts stop happening while the
 * ladder, the log and the pane all go on reporting them.
 *
 * Callers must re-mint the init per attempt (`composed-handler.ts` does), and
 * this is the belt behind that brace: an expired ceiling has already had its
 * say, and carrying it forward can only convert a live attempt into a no-op.
 */
export function mergeSignalIntoInit(
  init: Record<string, unknown>,
  signal?: AbortSignal
): RequestInit {
  if (!signal) return init as RequestInit;
  const own = init.signal as AbortSignal | undefined;
  if (!own || own.aborted) return { ...init, signal } as RequestInit;
  return { ...init, signal: AbortSignal.any([own, signal]) } as RequestInit;
}

export interface ConnectionRetryContext {
  providerName: string;
  providerDisplayName: string;
  /**
   * The endpoint the FAILING call was made to. On the inference path this is
   * the model endpoint; on an auth path the model endpoint may not be computed
   * yet and a refresh can contact several auth/setup/catalog hosts, so it is
   * read from the error. Naming the wrong host in the message is a real defect,
   * not a cosmetic one.
   */
  resolveEndpoint: (err: unknown) => string;
  /** Absolute deadline for THIS request, PROCESS ms. */
  deadlineAt: number;
  /** `c.req.raw.signal` — the client going away. */
  signal: AbortSignal;
}

/**
 * The counters every outcome carries, in TWO scopes, because the two answer
 * different questions and conflating them mis-reports both.
 *
 * EPISODE scope (`attempts`, `recoveryMs`) is what the human reads: one banner
 * saying "attempt 9 · 4m 12s in recovery" across every waiter and both tiers,
 * which is the honest account of the OUTAGE.
 *
 * REQUEST scope (`requestRetries`, `requestRecoveryMs`) is what stats record,
 * because a stats event is one-per-request by definition. The episode figures
 * cannot stand in for these: N concurrent requests share one episode, so each
 * would report the sum of all of them, and a tier-2 re-entry inherits counters
 * from a request that already recorded its own — so summing `retry_attempts`
 * over an outage would multiply it by the number of waiters and again by the
 * number of re-entries.
 */
interface ConnectionRetryTally {
  /** Episode-scoped: every attempt by every waiter, across both tiers. */
  attempts: number;
  /** Episode-scoped: ms since the episode opened. */
  recoveryMs: number;
  /**
   * THIS request's RE-ISSUES — the operation run again, not counting the
   * failure that brought us here. 0 is meaningful and reachable: an episode
   * existed and this request added nothing to it because its own budget was
   * already spent. That is what `retry_attempts` records.
   */
  requestRetries: number;
  /** THIS request's own ms inside the ladder — `recovery_ms`. */
  requestRecoveryMs: number;
  /** Which tier-2 re-entry this is. 0 = the request that opened the episode. */
  clientRetry: number;
  episodeId: string;
}

export type ConnectionRetryResult<T> =
  | ({ kind: "ok"; value: T } & ConnectionRetryTally)
  /**
   * NOTE the absence of a `uiLeased` field. Whether a surface is painting this
   * episode is LIVE and must be read at the moment the status is chosen; a
   * boolean on this result IS a cache of it, and by the time a caller
   * destructures the result it can already be stale.
   */
  | ({
      kind: "exhausted";
      conn: ConnectionErrorInfo;
      error: unknown;
      endpoint: string;
    } & ConnectionRetryTally)
  | ({
      kind: "gave_up";
      conn: ConnectionErrorInfo;
      error: unknown;
      endpoint: string;
    } & ConnectionRetryTally)
  | ({ kind: "client_gone" } & ConnectionRetryTally)
  /** A later attempt threw something that is NOT a connection error. Not ours. */
  | ({ kind: "threw"; error: unknown } & ConnectionRetryTally);

/** True when the rejection is the inbound client going away, not our own clamp. */
function isClientAbort(signal: AbortSignal, err: unknown): boolean {
  if (signal.aborted) return true;
  return (err as { name?: string })?.name === "AbortError";
}

/**
 * Await `p`, but stop waiting when `signal` fires.
 *
 * ── WHY THE CLAMP CANNOT JUST BE HANDED OVER AND TRUSTED ────────────────────
 *
 * `op` takes the signal, and the fetch path threads it all the way to `fetch`.
 * THE AUTH PATH CANNOT: `refreshAuth()` and `getHeaders()` take no arguments on
 * the transport interface, so `() => this.provider.refreshAuth!()` closes over
 * nothing and discards the signal entirely. Grok's token exchange then performs
 * an UNBOUNDED `fetch(auth.x.ai/oauth2/token)` — so a swallowed connection
 * outlived both the 45-second attempt cap and the client's own disconnect,
 * while `withConnectionRetry` sat awaiting a promise nothing could settle. A
 * deadline that one path can ignore is not a deadline.
 *
 * So the clamp is enforced HERE, at the one place that owns it, rather than in
 * N transports that would each have to remember. The operation is abandoned,
 * not cancelled — it may still be running — but the waiter unwinds, the ladder
 * advances, and the request answers inside its budget, which is what the budget
 * was for. Threading a real signal into every auth call is the deeper fix and
 * is worth doing; this is what makes the ceiling true in the meantime.
 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Nothing else will ever observe `p`, so claim its rejection here or Bun
    // reports an unhandled one.
    void p.catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Registered unconditionally, so a late settle of an abandoned operation is
    // always handled — `resolve`/`reject` after settlement are no-ops.
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/**
 * Re-issue `op` on a classified connection error, on the shared episode clock.
 *
 * `op` TAKES the signal rather than closing over one. That is what lets a
 * single contract cover both the fetch path and the auth path: the per-attempt
 * clamp is built here, merged with the client signal here, and handed in, so
 * the clamp bounds the OPERATION rather than only the `fetch` buried inside it.
 * `untilAborted` then makes that binding rather than advisory, for the auth
 * closures that structurally cannot accept a signal at all.
 *
 * Classification runs on EVERY attempt, not just the first. A retry that throws
 * an auth failure, a transport bug or a programming error must not be
 * relabelled as the previous network error — that would quietly widen recovery
 * past the classified set. Such a result comes back as `threw` and the caller
 * rethrows it exactly as it rethrows an unclassifiable first failure today.
 */
export async function withConnectionRetry<T>(
  op: (signal: AbortSignal) => Promise<T>,
  first: unknown,
  ctx: ConnectionRetryContext
): Promise<ConnectionRetryResult<T>> {
  const clock = recoveryClock();
  // PROCESS ms at which THIS request entered the ladder. `recovery_ms` is
  // measured from here rather than from the episode, because an episode can be
  // older than the request that joined it — a tier-2 re-entry inherits one —
  // and a `recovery_ms` larger than the same record's `latency_ms` is a figure
  // no reader can make sense of.
  const enteredAtPerf = clock.now();
  let requestRetries = 0;

  const firstConn = classifyConnectionError(first);
  if (!firstConn) {
    // The caller is contractually required to classify before calling. Being
    // defensive here costs nothing and keeps a future caller's mistake from
    // silently widening what "transient" means.
    return {
      kind: "threw",
      error: first,
      attempts: 0,
      recoveryMs: 0,
      requestRetries: 0,
      requestRecoveryMs: 0,
      clientRetry: 0,
      episodeId: "",
    };
  }

  let conn: ConnectionErrorInfo = firstConn;
  let error: unknown = first;
  let endpoint = ctx.resolveEndpoint(first);

  // A shortened hold is announced HERE — once a hold is really happening —
  // rather than by `tier1DeadlineAt`, which the healthy path now calls.
  noteDeadlineForEpisode();

  const handle: EpisodeHandle = joinEpisode({
    providerName: ctx.providerName,
    providerDisplayName: ctx.providerDisplayName,
    endpoint,
    kind: conn.kind,
    code: conn.code,
    reason: buildConnectionErrorMessage(conn.kind, ctx.providerDisplayName, endpoint),
    deadlineAt: ctx.deadlineAt,
  });

  /**
   * The counters, snapshotted at the instant an outcome is returned. Every
   * `return` in this function goes through it, so a new counter is added in one
   * place and cannot be forgotten on one arm — which is how five hand-written
   * copies of the same four fields drift.
   */
  const tally = () => ({
    attempts: handle.attempts(),
    recoveryMs: handle.recoveryMs(),
    requestRetries,
    requestRecoveryMs: Math.round(clock.now() - enteredAtPerf),
    clientRetry: handle.clientRetries(),
    episodeId: handle.episodeId,
  });

  try {
    handle.recordAttemptResult(conn.code, false);

    for (;;) {
      // ── FOUR ABORT PATHS, AND WHY NONE OF THEM IS REDUNDANT ───────────────
      //
      // A black-box mutation (M6) disabled the three in THIS file — this check,
      // `untilAborted`, and `mergeSignalIntoInit`'s threading — and the client
      // disconnect was still handled. It was not proof of redundancy: the
      // surviving path is `coordinator.ts`'s `waitForNextAttempt`, which
      // registers its own `abort` listener on the same signal, and a ladder
      // against a REFUSED loopback port spends ~100% of its wall clock parked
      // in that wait. The mutation test aborted during a wait, so the wait's
      // own listener answered it.
      //
      // Each covers a window no other one does:
      //
      //   1. HERE — an abort that landed while an attempt was settling, or
      //      before any wait has happened at all (first iteration). Nothing
      //      else is listening in that gap.
      //   2. `coordinator.waitForNextAttempt` — during the wait. Also the only
      //      one that can DETACH the waiter from the shared episode timer.
      //   3. `untilAborted` — during an attempt whose operation structurally
      //      cannot take a signal: `refreshAuth()`/`getHeaders()` accept no
      //      arguments, so for the auth path this is the ONLY unwind there is.
      //   4. `mergeSignalIntoInit` — inside `fetch`, so the SOCKET closes
      //      rather than being abandoned. The other three unwind the waiter and
      //      leave the connect running.
      //
      // A slow connect inverts the mutation's arithmetic: 45 s of attempt to
      // 5 s of wait means (3) and (4) do nearly all the work and (2) almost
      // none. Deleting any of them leaves a window that only shows up under the
      // fault class the loopback suite cannot produce.
      if (ctx.signal.aborted) {
        return { kind: "client_gone", ...tally() };
      }

      // The budget this waiter has left for a WAIT: its own deadline, less the
      // slot the attempt after the wait needs. The check bounds the ATTEMPT
      // THAT FOLLOWS the sleep, not just the sleep — bounding only the sleep is
      // how a budget stops being a ceiling.
      const waitBudget = ctx.deadlineAt - clock.now() - MIN_ATTEMPT_SLOT_MS;
      let delay = connectionRetryDelayMs(handle.ladderIndex());

      if (delay > waitBudget) {
        // ── A CARRIED RUNG MAY BE TRUNCATED, ONCE, BY A REQUEST THAT HAS NOT
        //    RE-ISSUED ANYTHING YET ──────────────────────────────────────────
        //
        // The ladder index belongs to the EPISODE and deliberately does not
        // reset when the client re-asks (§2: restarting at 5 s would hammer a
        // dead host harder the longer the outage lasted). But the deadline
        // belongs to the SOCKET, and a re-ask gets a fresh, possibly SHORTER
        // one. Once the carried rung outgrew that deadline — 60 s carried into
        // a 30 s budget — this gate fired on the very first iteration and the
        // request answered in 8 ms having re-issued NOTHING. Measured at the
        // upstream socket: with `API_TIMEOUT_MS=60000`, request 2 of an outage
        // made one connect and was done, permanently, because the 400 it
        // answered is not a status Claude Code re-asks. Invisible at the 270 s
        // default, where the terminal 60 s rung always fits; it bites every
        // `API_TIMEOUT_MS ≤ 90 s`, a value the docs invite.
        //
        // So a request that has not yet re-issued once spends what it has
        // instead of handing back an empty turn: the wait shrinks to the
        // budget, one attempt is made, and only then does it hand off. It is
        // not a hammer — the floor is `MIN_ATTEMPT_SLOT_MS`, it happens at most
        // once per request, and the gap between two client re-asks is the
        // client's own backoff (up to 38.4 s), not ours.
        const mayTruncate = requestRetries === 0 && waitBudget >= MIN_ATTEMPT_SLOT_MS;
        if (!mayTruncate) {
          handle.handoff();
          return { kind: "exhausted", conn, error, endpoint, ...tally() };
        }
        delay = waitBudget;
      }

      let waited: { kind: "attempt" } | { kind: "gave_up" };
      try {
        waited = await handle.waitForNextAttempt(ctx.signal, delay);
      } catch (err) {
        if (isClientAbort(ctx.signal, err)) {
          log(`[Recovery] client gone during wait (episode ${handle.episodeId})`);
          return { kind: "client_gone", ...tally() };
        }
        throw err;
      }

      if (waited.kind === "gave_up") {
        return { kind: "gave_up", conn, error, endpoint, ...tally() };
      }

      // Per-attempt clamp. Cleared the moment the operation settles, so it can
      // only ever bound connect-and-headers.
      const attemptAc = new AbortController();
      const remaining = ctx.deadlineAt - clock.now();
      const clampMs = Math.max(
        MIN_ATTEMPT_SLOT_MS,
        Math.min(PER_ATTEMPT_CONNECT_CAP_MS, remaining)
      );
      // `markOwnTimeout` is what makes this abort re-classifiable at all.
      // `classifyConnectionError` keys `TimeoutError` on the SIGNAL'S ORIGIN
      // rather than on the name, precisely so a transport's own inference
      // ceiling stays out of the ladder — so the clamp has to say it is ours.
      const clampTimer = clock.setTimeout(
        () => attemptAc.abort(markOwnTimeout(new DOMException("attempt cap", "TimeoutError"))),
        clampMs
      );
      const merged = AbortSignal.any([ctx.signal, attemptAc.signal]);

      try {
        requestRetries++;
        const value = await untilAborted(op(merged), merged);
        handle.recordAttemptResult("ok", true);
        logRecovery(
          `[Recovery] ${ctx.providerDisplayName} recovered after ${handle.attempts()} attempts ` +
            `in ${handle.recoveryMs()}ms (episode ${handle.episodeId})`
        );
        return { kind: "ok", value, ...tally() };
      } catch (err) {
        if (isClientAbort(ctx.signal, err)) {
          log(`[Recovery] client gone during attempt (episode ${handle.episodeId})`);
          return { kind: "client_gone", ...tally() };
        }
        // Re-classify EVERY attempt. Our own clamp lands here as a
        // `TimeoutError`, which classification now recognises for the same
        // reason a hung upstream does: both are a failure to get a response
        // out of a host we could not reach in time.
        const next = classifyConnectionError(err);
        if (!next) {
          return { kind: "threw", error: err, ...tally() };
        }
        conn = next;
        error = err;
        endpoint = ctx.resolveEndpoint(err) || endpoint;
        handle.recordAttemptResult(next.code, false);
      } finally {
        clock.clearTimeout(clampTimer);
      }
    }
  } finally {
    // Unconditional. A waiter that never leaves is the subscribe-without-
    // unsubscribe leak this design named as its own most likely failure.
    handle.leave();
  }
}
