/**
 * CONTRACT POINT 1 (a connection failure no longer answers immediately),
 * CONTRACT POINT 5 (`x-claudish-no-recovery` skips the ladder) and the
 * env-var arm of CONTRACT POINT 8.
 *
 * BLACK BOX. Every attempt is counted at an upstream socket we own; every
 * status is read from `Response.status` of a fetch against the proxy's own URL,
 * i.e. AFTER any internal status remap.
 *
 * Trap T-7 is the reason this file is shaped the way it is: an "immediate 400"
 * assertion passes just as well on a build where the whole feature is off. So
 * every fast-fail scenario here is PAIRED with an enabled control run against
 * an identical fixture in the same process, and the control asserts a second
 * upstream CONNECTION, not merely a slower answer.
 *
 * Every arm takes its own endpoint from the pool: an episode is per-endpoint
 * and outlives the request that opened it, so a shared endpoint would let the
 * previous arm's rung explain the next arm's result.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type FixturePool,
  type ProxyHandle,
  assertRefused,
  createRawFixturePool,
  endpointsConfig,
  envSnapshot,
  postMessage,
  reservePorts,
  scheduledAttemptOffsets,
  sleep,
  startHealthyFixture,
  startProxy,
  startStatusFixture,
} from "./fixtures.js";

const API_TIMEOUT_MS = 60_000; // ⇒ derived deadline 30s ⇒ attempts at 0s, 5s, 15s
const DEADLINE_MS = 30_000;

let restoreEnv: () => void;
let proxy: ProxyHandle;
let pool: FixturePool;
let healthy: ReturnType<typeof startHealthyFixture>;
let upstream500: ReturnType<typeof startStatusFixture>;
let deadPort: number;

beforeAll(async () => {
  restoreEnv = envSnapshot(["API_TIMEOUT_MS", "CLAUDISH_RECOVERY", "CLAUDISH_RECOVERY_UI"]);
  process.env.API_TIMEOUT_MS = String(API_TIMEOUT_MS);
  delete process.env.CLAUDISH_RECOVERY;

  const [healthyPort, errPort, refusedPort] = reservePorts(3);
  deadPort = refusedPort;

  pool = createRawFixturePool(8, "ep-rst");
  healthy = startHealthyFixture("HEALTHY-FIXTURE-ANSWER", healthyPort);
  upstream500 = startStatusFixture(500, errPort);

  proxy = await startProxy(
    endpointsConfig([
      ...pool.specs,
      { name: "ep-live", port: healthyPort, model: "m-live" },
      { name: "ep-500", port: errPort, model: "m-500" },
      { name: "ep-refused", port: refusedPort, model: "m-refused" },
    ])
  );

  // Warm the proxy (catalog/registry latching) so the "<2s" negatives measure
  // the request path rather than one-time startup work.
  const warm = await postMessage(proxy.url, { model: "ep-live@m-live" });
  expect(warm.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await proxy?.shutdown();
  pool?.stopAll();
  healthy?.stop();
  upstream500?.stop();
  restoreEnv?.();
});

/**
 * Issue a request against a fresh endpoint and resolve as soon as the fixture
 * has seen `n` connections, then abort. An "is the ladder really on?" control
 * therefore costs one rung rather than a whole deadline.
 */
async function ladderReaches(
  n: number,
  headers?: Record<string, string>,
  budgetMs = 20_000
): Promise<{ connections: number; answeredBeforeNthAttempt: boolean }> {
  const { model, fixture } = pool.next();
  const controller = new AbortController();
  let settled = false;
  const pending = postMessage(proxy.url, { model, headers, signal: controller.signal })
    .then(() => {
      settled = true;
    })
    .catch(() => {
      settled = true;
    });

  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (fixture.connections.length >= n || settled) break;
    await sleep(50);
  }
  const connections = fixture.connections.length;
  const answeredBeforeNthAttempt = settled && connections < n;
  controller.abort();
  await pending;
  return { connections, answeredBeforeNthAttempt };
}

describe("CP-1 — a connection failure enters a retry ladder instead of answering", () => {
  test("the upstream socket records the published ladder, truncated by the derived deadline", async () => {
    const { model, fixture } = pool.next();
    let answered = false;
    const request = postMessage(proxy.url, { model }).then((r) => {
      answered = true;
      return r;
    });

    // CP1-01: nothing has been answered while the first rung is still waiting.
    await sleep(2_000);
    expect(answered).toBe(false);

    const result = await request;

    // Counted at the socket, never from a [Recovery] line (trap T-9).
    const expectedOffsets = scheduledAttemptOffsets(DEADLINE_MS); // [0, 5000, 15000]
    expect(fixture.connections.length).toBe(expectedOffsets.length);

    const offsets = fixture.offsetsFromFirst();
    for (const [i, expected] of expectedOffsets.entries()) {
      expect(Math.abs(offsets[i] - expected)).toBeLessThan(1_500);
    }

    // No attempt may start after the derived deadline.
    expect(Math.max(...offsets)).toBeLessThan(DEADLINE_MS);

    // The answer is read at the proxy's public URL, after any remap (T-6).
    expect(result.status).not.toBe(200);
    expect(result.elapsedMs).toBeGreaterThan(15_000);
  }, 60_000);

  test("a client re-ask during the same outage is still retried, not answered instantly", async () => {
    // The shipped design hands the retry back to the client at the deadline
    // and the client re-enters the SAME episode (requirements, AMENDMENTS
    // table, FR-3/FR-4). A re-ask that fast-fails would end the recovery the
    // amendment promises to continue across requests.
    const { model, fixture } = pool.next();
    const first = await postMessage(proxy.url, { model });
    expect(first.status).not.toBe(200);
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);

    fixture.reset();
    const reask = await postMessage(proxy.url, { model });
    expect(reask.status).not.toBe(200);
    expect(fixture.connections.length).toBeGreaterThanOrEqual(2);
  }, 90_000);

  test("NEGATIVE: a reachable upstream that answers an error is answered at once, with no ladder", async () => {
    const before = upstream500.hits;
    const result = await postMessage(proxy.url, { model: "ep-500@m-500" });
    expect(result.elapsedMs).toBeLessThan(2_000);
    expect(upstream500.hits).toBe(before + 1);
    expect(result.status).toBeGreaterThanOrEqual(400);
  }, 20_000);

  test("NEGATIVE: a healthy upstream answers 200 with the fixture's own text", async () => {
    const result = await postMessage(proxy.url, { model: "ep-live@m-live" });
    expect(result.status).toBe(200);
    expect(result.body).toContain("HEALTHY-FIXTURE-ANSWER");
    expect(result.elapsedMs).toBeLessThan(2_000);
  }, 20_000);

  test("NEGATIVE: /v1/models and /v1/messages/count_tokens never enter the ladder", async () => {
    await assertRefused(deadPort);

    const t0 = Date.now();
    const models = await fetch(`${proxy.url}/v1/models`);
    await models.text();
    expect(models.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2_000);

    const t1 = Date.now();
    const count = await fetch(`${proxy.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ep-refused@m-refused",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await count.text();
    expect(Date.now() - t1).toBeLessThan(2_000);
  }, 20_000);
});

describe("CP-5 — x-claudish-no-recovery: 1 skips the ladder", () => {
  test("with the header: one upstream attempt, a connection_error in under a second", async () => {
    const { model, fixture } = pool.next();
    const result = await postMessage(proxy.url, {
      model,
      headers: { "x-claudish-no-recovery": "1" },
    });

    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body).error.type).toBe("connection_error");
    // The decisive half: the ladder never ran at the socket.
    expect(fixture.connections.length).toBe(1);
  }, 20_000);

  test("PAIRED CONTROL: identical fixture, same process, header removed ⇒ a second attempt arrives", async () => {
    const control = await ladderReaches(2);
    expect(control.answeredBeforeNthAttempt).toBe(false);
    expect(control.connections).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("the header is honoured case-insensitively", async () => {
    const { model, fixture } = pool.next();
    const result = await postMessage(proxy.url, {
      model,
      headers: { "X-Claudish-No-Recovery": "1" },
    });
    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(result.status).toBe(400);
    expect(fixture.connections.length).toBe(1);
  }, 20_000);

  test("the skip also holds on the streaming path", async () => {
    const { model, fixture } = pool.next();
    const result = await postMessage(proxy.url, {
      model,
      stream: true,
      headers: { "x-claudish-no-recovery": "1" },
    });
    expect(result.elapsedMs).toBeLessThan(2_000);
    expect(fixture.connections.length).toBe(1);
  }, 20_000);
});

describe("CP-8 — the environment switch, with its paired enabled control", () => {
  test("CLAUDISH_RECOVERY=0 ⇒ one attempt and an immediate error", async () => {
    const { model, fixture } = pool.next();
    process.env.CLAUDISH_RECOVERY = "0";
    try {
      const result = await postMessage(proxy.url, { model });
      expect(result.elapsedMs).toBeLessThan(2_000);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).error.type).toBe("connection_error");
      expect(fixture.connections.length).toBe(1);
    } finally {
      delete process.env.CLAUDISH_RECOVERY;
    }
  }, 20_000);

  test("PAIRED CONTROL: the switch removed, same process ⇒ the ladder runs again", async () => {
    delete process.env.CLAUDISH_RECOVERY;
    const control = await ladderReaches(2);
    expect(control.answeredBeforeNthAttempt).toBe(false);
    expect(control.connections).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("the switch does not change the healthy path's answer", async () => {
    process.env.CLAUDISH_RECOVERY = "0";
    let off: Awaited<ReturnType<typeof postMessage>>;
    try {
      off = await postMessage(proxy.url, { model: "ep-live@m-live" });
    } finally {
      delete process.env.CLAUDISH_RECOVERY;
    }
    expect(off.status).toBe(200);
    expect(off.body).toContain("HEALTHY-FIXTURE-ANSWER");

    const on = await postMessage(proxy.url, { model: "ep-live@m-live" });
    expect(on.status).toBe(200);
    expect(on.body).toContain("HEALTHY-FIXTURE-ANSWER");
    expect(JSON.parse(on.body).content).toEqual(JSON.parse(off.body).content);
  }, 20_000);
});
