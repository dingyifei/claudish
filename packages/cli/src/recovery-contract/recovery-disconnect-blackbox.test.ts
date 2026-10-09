/**
 * CONTRACT POINT 7 — a client disconnect stops the retry promptly.
 *
 * REAL TIME ONLY. A fake clock cannot see a timer that was never cancelled,
 * because the timer only fires when time really passes.
 *
 * Trap T-11 is the one this file is built around: aborting BEFORE any attempt
 * has happened makes "it stopped retrying" trivially true. So the abort here
 * happens only after the fixture has observed ≥2 attempts, and it lands inside
 * a KNOWN wait rung — the third attempt is due at a time we can name, and the
 * assertion is that it never arrives.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type FixturePool,
  type ProxyHandle,
  type RawFixture,
  createRawFixturePool,
  endpointsConfig,
  envSnapshot,
  postMessage,
  sleep,
  startProxy,
} from "./fixtures.js";

const API_TIMEOUT_MS = 60_000; // ⇒ 30s deadline ⇒ attempts at 0s, 5s, 15s

let restoreEnv: () => void;
let proxy: ProxyHandle;
let pool: FixturePool;

beforeAll(async () => {
  restoreEnv = envSnapshot(["API_TIMEOUT_MS", "CLAUDISH_RECOVERY"]);
  process.env.API_TIMEOUT_MS = String(API_TIMEOUT_MS);
  delete process.env.CLAUDISH_RECOVERY;

  pool = createRawFixturePool(6, "ep-abort");
  proxy = await startProxy(endpointsConfig(pool.specs));
}, 60_000);

afterAll(async () => {
  await proxy?.shutdown();
  pool?.stopAll();
  restoreEnv?.();
});

async function waitForAttempts(fixture: RawFixture, n: number, budgetMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (fixture.connections.length >= n) return;
    await sleep(25);
  }
  throw new Error(
    `fixture saw only ${fixture.connections.length} attempts in ${budgetMs}ms; expected ${n}`
  );
}

describe("CP-7 — client disconnect stops the ladder", () => {
  test("no further upstream attempt arrives after the client goes away mid-rung", async () => {
    const { model, fixture } = pool.next();
    const controller = new AbortController();
    const pending = postMessage(proxy.url, { model, signal: controller.signal }).catch(
      (e: unknown) => e
    );

    // Let the ladder demonstrably run: attempts at t≈0 and t≈5s.
    await waitForAttempts(fixture, 2, 12_000);
    const attemptsAtAbort = fixture.connections.length;
    expect(attemptsAtAbort).toBeGreaterThanOrEqual(2);

    // Abort INSIDE the 10s wait rung. The next attempt is due at t≈15s.
    await sleep(1_500);
    controller.abort();
    await pending;

    // Watch well past the moment attempt 3 was due.
    await sleep(12_000);
    expect(fixture.connections.length).toBe(attemptsAtAbort);
  }, 60_000);

  test("NEGATIVE CONTROL: with nobody aborting, the third attempt does arrive", async () => {
    // Without this, the assertion above ("no new connection after the abort")
    // is satisfied by any build that simply stops after two attempts — the
    // abort would be doing none of the work. Same fixture shape, same rung,
    // the only difference is that nothing aborts.
    const { model, fixture } = pool.next();
    const controller = new AbortController();
    const pending = postMessage(proxy.url, { model, signal: controller.signal }).catch(
      (e: unknown) => e
    );
    await waitForAttempts(fixture, 3, 25_000);
    expect(fixture.connections.length).toBeGreaterThanOrEqual(3);
    controller.abort();
    await pending;
  }, 45_000);

  test("aborting one request does not stop another request's ladder", async () => {
    // Guards a single shared coordinator: A's abort must not cancel B.
    const a = pool.next();
    const b = pool.next();

    const controllerA = new AbortController();
    const pendingA = postMessage(proxy.url, {
      model: a.model,
      signal: controllerA.signal,
    }).catch((e: unknown) => e);
    const pendingB = postMessage(proxy.url, { model: b.model });

    await waitForAttempts(a.fixture, 2, 12_000);
    await waitForAttempts(b.fixture, 2, 12_000);

    const aAtAbort = a.fixture.connections.length;
    controllerA.abort();
    await pendingA;

    const resultB = await pendingB;
    expect(resultB.status).toBeGreaterThanOrEqual(400);
    // B ran its full schedule …
    expect(b.fixture.connections.length).toBeGreaterThanOrEqual(3);
    // … while A stopped where it was.
    expect(a.fixture.connections.length).toBe(aAtAbort);
  }, 90_000);

  test("shutdown after an aborted ladder resolves promptly", async () => {
    // NFR-2: a live 60s timer keeps the loop alive and is invisible from
    // inside the request path.
    const ownPool = createRawFixturePool(1, "ep-shutdown");
    const ownProxy = await startProxy(endpointsConfig(ownPool.specs));
    try {
      const { model, fixture } = ownPool.next();
      const controller = new AbortController();
      const pending = postMessage(ownProxy.url, { model, signal: controller.signal }).catch(
        (e: unknown) => e
      );
      await waitForAttempts(fixture, 2, 12_000);
      controller.abort();
      await pending;

      const t0 = Date.now();
      await ownProxy.shutdown();
      expect(Date.now() - t0).toBeLessThan(1_000);
    } finally {
      ownPool.stopAll();
    }
  }, 60_000);
});
