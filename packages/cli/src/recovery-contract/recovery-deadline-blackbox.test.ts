/**
 * CONTRACT POINT 2 — the recovery deadline is DERIVED from `API_TIMEOUT_MS`,
 * never a constant that happens to equal the default.
 *
 * `min(API_TIMEOUT_MS, 300s) − 30s` (docs/advanced/environment.md). The
 * expected attempt schedule is COMPUTED from that formula and the published
 * ladder (FR-2, 5/10/30/60…), so no attempt count and no handoff time is
 * hardcoded anywhere in this file.
 *
 * Two traps live here, and both need more than one value in ONE process:
 *   T-4 a deadline that is a constant equal to the default passes any
 *       single-value run;
 *   T-5 an env var read once at module load passes whichever value ran first.
 * So this file runs 40s → 60s → 40s and asserts each on its own merits; a
 * module-load snapshot yields the same schedule three times and fails twice.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type ProxyHandle,
  createRawFixturePool,
  derivedDeadlineMs,
  endpointsConfig,
  envSnapshot,
  postMessage,
  scheduledAttemptOffsets,
  sleep,
  startProxy,
} from "./fixtures.js";

let restoreEnv: (() => void) | undefined;
let liveProxy: ProxyHandle | undefined;
let livePool: ReturnType<typeof createRawFixturePool> | undefined;

afterEach(async () => {
  await liveProxy?.shutdown();
  liveProxy = undefined;
  livePool?.stopAll();
  livePool = undefined;
  restoreEnv?.();
  restoreEnv = undefined;
});

interface LadderRun {
  offsets: number[];
  gaps: number[];
  status: number;
  elapsedMs: number;
  body: string;
}

/**
 * Run one full ladder to exhaustion under `apiTimeoutMs`.
 *
 * A fresh proxy per value, so the test does not accidentally pin WHEN the
 * implementation is allowed to read the variable — only that the value it
 * ends up using is the one the environment stated.
 */
async function runLadderUnder(apiTimeoutMs: number): Promise<LadderRun> {
  restoreEnv = envSnapshot(["API_TIMEOUT_MS", "CLAUDISH_RECOVERY"]);
  process.env.API_TIMEOUT_MS = String(apiTimeoutMs);
  delete process.env.CLAUDISH_RECOVERY;

  const pool = createRawFixturePool(1, "ep-deadline");
  livePool = pool;
  const proxy = await startProxy(endpointsConfig(pool.specs));
  liveProxy = proxy;

  const { model, fixture } = pool.next();
  const result = await postMessage(proxy.url, { model });
  return {
    offsets: fixture.offsetsFromFirst(),
    gaps: fixture.gaps(),
    status: result.status,
    elapsedMs: result.elapsedMs,
    body: result.body,
  };
}

function expectSchedule(run: LadderRun, apiTimeoutMs: number): void {
  const deadline = derivedDeadlineMs(apiTimeoutMs);
  const expected = scheduledAttemptOffsets(deadline);

  expect(run.offsets.length).toBe(expected.length);
  for (const [i, want] of expected.entries()) {
    expect(Math.abs(run.offsets[i] - want)).toBeLessThan(1_500);
  }
  // The published ladder, read off the wire: 5s then 10s then 30s …
  for (const [i, gap] of run.gaps.entries()) {
    const want = expected[i + 1] - expected[i];
    expect(Math.abs(gap - want)).toBeLessThan(1_000);
  }
  // Nothing may start after the derived deadline, and the client must be
  // answered inside it (measured from inbound request start).
  expect(Math.max(...run.offsets)).toBeLessThan(deadline);
  expect(run.elapsedMs).toBeLessThan(deadline + 5_000);
}

describe("CP-2 — the deadline derives from API_TIMEOUT_MS", () => {
  test("API_TIMEOUT_MS=40000 ⇒ the schedule the derived 10s deadline admits", async () => {
    const run = await runLadderUnder(40_000);
    expectSchedule(run, 40_000);
    expect(run.status).toBe(400);
  }, 60_000);

  test("API_TIMEOUT_MS=60000 ⇒ a LONGER schedule in the same process (anti-hardcode)", async () => {
    const run = await runLadderUnder(60_000);
    expectSchedule(run, 60_000);
    // The point of the pairing: this run must contain strictly more attempts
    // than the 40s run above. A constant 270s deadline never gets here (the
    // per-test timeout kills it); a constant anything gives both runs the
    // same count.
    expect(run.offsets.length).toBeGreaterThan(
      scheduledAttemptOffsets(derivedDeadlineMs(40_000)).length
    );
  }, 90_000);

  test("back to API_TIMEOUT_MS=40000 in the same process ⇒ the short schedule returns", async () => {
    // T-5: an implementation that snapshots the env at module load passes the
    // first of these three and fails whichever ran second and third.
    const run = await runLadderUnder(40_000);
    expectSchedule(run, 40_000);
  }, 60_000);

  test("a garbled API_TIMEOUT_MS falls back to a working deadline rather than NaN", async () => {
    restoreEnv = envSnapshot(["API_TIMEOUT_MS", "CLAUDISH_RECOVERY"]);
    process.env.API_TIMEOUT_MS = "abc";
    delete process.env.CLAUDISH_RECOVERY;

    const pool = createRawFixturePool(1, "ep-garbled");
    livePool = pool;
    const proxy = await startProxy(endpointsConfig(pool.specs));
    liveProxy = proxy;

    const { model, fixture } = pool.next();
    const controller = new AbortController();
    const pending = postMessage(proxy.url, { model, signal: controller.signal }).catch(() => null);

    // A NaN deadline collapses to "no budget" and answers instantly; a
    // negative one does the same. Either way the second rung never arrives.
    const started = Date.now();
    while (Date.now() - started < 12_000 && fixture.connections.length < 2) await sleep(50);
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(fixture.gaps()[0] - 5_000)).toBeLessThan(1_000);
    controller.abort();
    await pending;
  }, 40_000);

  test("an API_TIMEOUT_MS below one rung still answers, bounded, without crashing", async () => {
    // A-1: the contract states no floor for `min(API_TIMEOUT_MS,300s)−30s`,
    // so the only thing assertable here is that a sub-rung deadline neither
    // hangs nor produces a negative budget. The floor itself stays untestable
    // until it is pinned.
    const run = await runLadderUnder(31_000);
    expect(run.status).toBe(400);
    expect(JSON.parse(run.body).error.type).toBe("connection_error");
    expect(run.offsets.length).toBeGreaterThanOrEqual(1);
    expect(run.elapsedMs).toBeLessThan(30_000);
  }, 60_000);
});
