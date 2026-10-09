/**
 * The shape of one outage, as the banner draws it.
 *
 * No imports, deliberately: the coordinator builds this and `magmux-ui.ts`
 * reads it, and neither should drag the other's dependencies along.
 *
 * FRAMES ARE FAT ON PURPOSE. One frame carries the whole banner — provider,
 * host, endpoint, reason sentence, counters, the next-attempt instant — so the
 * banner can be drawn from a single value with nothing to look up.
 *
 * TIMESTAMPS HERE ARE EPOCH MS (`Date.now()`), named `…AtMs`. Everything the
 * coordinator measures intervals with is process ms (`performance.now()`) and is
 * converted exactly once, in `renderableEpisodeFrame()`. A process-ms instant
 * drawn as a countdown is an arbitrary number with no error anywhere.
 */

/** The live states. A recovered or abandoned episode is no longer drawn. */
export type RecoveryFrameState = "attempting" | "waiting" | "handoff";

export interface RecoveryEpisodeFrame {
  type: "episode";
  episodeId: string;
  state: RecoveryFrameState;
  /** DISPLAY ONLY — the highest tier any waiter in this episode has reached. */
  tier: 1 | 2;
  providerDisplayName: string;
  /** `chatgpt.com` — the host alone, for the banner. */
  host: string;
  /** The endpoint that actually failed; the AUTH host on an auth-path failure. */
  endpoint: string;
  kind: "dns" | "refused" | "unreachable";
  code: string | null;
  loopback: boolean;
  /** `buildConnectionErrorMessage(...)` verbatim — the SAME sentence the inline 400 carries. */
  reason: string;
  attempts: number;
  clientRetries: number;
  /** EPOCH ms. */
  startedAtMs: number;
  /** EPOCH ms, or null while an attempt is actually in flight. */
  nextAttemptAtMs: number | null;
  lastOutcome: string;
  waiters: number;
  /** How many OTHER live episodes exist, so the banner can say `+N more`. */
  otherEpisodes: number;
}

/**
 * A lease lives this long after magmux last acknowledged a banner write for its
 * episode.
 *
 * NEVER compare this against a per-attempt connect cap. They measure unrelated
 * things — one the renderer's liveness, the other a network ceiling — and they
 * must stay independent.
 */
export const UI_LEASE_MS = 10_000;

/**
 * The banner is redrawn this often while any outage is live. It is both the
 * countdown's resolution and the lease's renewal, and 10× inside `UI_LEASE_MS`.
 */
export const FRAME_TICK_MS = 1_000;
