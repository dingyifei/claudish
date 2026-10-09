/**
 * The one clock the recovery machinery reads.
 *
 * Every interval in this subsystem is measured in PROCESS ms — the unit
 * `performance.now()` returns and the unit `composed-handler.ts`'s `startTime`
 * already carries. Epoch ms (`Date.now()`) is reserved for values that cross a
 * process boundary or are shown to a human, and the two are never differenced
 * against each other. Nothing here produces epoch ms; the pane protocol that
 * needs it is a later phase.
 *
 * It is injectable for ONE reason: the backoff ladder is 5/10/30/60/60 seconds,
 * and a unit test that asserts those gaps against the real clock takes three
 * minutes and is flaky at the margins. `mock.module()` is not an option — the
 * project's standing rule is that mocking shared infrastructure bleeds across
 * sibling test files in Bun's module registry — so the seam is an explicit
 * parameterless injection instead.
 */

export interface RecoveryClock {
  /** PROCESS ms, monotonic. Same origin as `performance.now()`. */
  now(): number;
  /** Returns an opaque handle understood by this clock's `clearTimeout`. */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * Stop a pending timer holding the event loop open.
   *
   * Used for exactly one timer — the post-handoff grace, which outlives the
   * request that created it and must never be the reason the process refuses
   * to exit. The ATTEMPT timer is deliberately NOT unref'd: a handler awaiting
   * the next rung has nothing else keeping Bun's loop alive, so unref'ing it
   * would end the run instead of the wait.
   */
  unref?(handle: unknown): void;
}

const REAL_CLOCK: RecoveryClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  unref: (handle) => {
    (handle as { unref?: () => void })?.unref?.();
  },
};

let active: RecoveryClock = REAL_CLOCK;

/** The clock every recovery module reads. Never cache the RESULT of `now()`. */
export function recoveryClock(): RecoveryClock {
  return active;
}

/**
 * Install a deterministic clock. Tests only — production never calls this, and
 * a test that does MUST restore in an `afterEach`, because this is module
 * state shared with every other test in the same Bun process.
 */
export function setRecoveryClock(clock: RecoveryClock): void {
  active = clock;
}

/** Restore the real clock. */
export function resetRecoveryClock(): void {
  active = REAL_CLOCK;
}
