/**
 * The SLOW-FAULT arm. Trap T-1, made executable.
 *
 * Every loopback refusal in this suite fails in about one millisecond, and a
 * ~1ms fault is the one kind that cannot exercise anything that decays DURING
 * an attempt: a per-attempt connect cap, a budget measured from inbound request
 * start, or a liveness signal that a long silent attempt would let expire. The
 * class of the originating incident — `unreachable`/`ETIMEDOUT` — is measured
 * in tens of seconds, not milliseconds, and the validation contract's own
 * C-18 exists because a suite built entirely on refusals is blind to it.
 *
 * Fault: F-SLOWCONNECT — `192.0.2.1` (TEST-NET-1, RFC 5737, unrouted), so the
 * TCP connect burns the OS timeout instead of being refused. Local, no
 * privileges, no network manipulation.
 *
 * REAL TIME. A fake clock makes every assertion in this file vacuous.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ProxyHandle,
  derivedDeadlineMs,
  endpointsConfig,
  envSnapshot,
  postMessage,
  sleep,
  startProxy,
} from "./fixtures.js";

const API_TIMEOUT_MS = 60_000; // ⇒ 30s derived deadline
const DEADLINE_MS = derivedDeadlineMs(API_TIMEOUT_MS);

let restoreEnv: () => void;
let proxy: ProxyHandle;

beforeAll(async () => {
  restoreEnv = envSnapshot(["API_TIMEOUT_MS", "CLAUDISH_RECOVERY"]);
  process.env.API_TIMEOUT_MS = String(API_TIMEOUT_MS);
  delete process.env.CLAUDISH_RECOVERY;

  proxy = await startProxy(
    endpointsConfig([{ name: "ep-slow", port: 0, model: "m-slow", url: "https://192.0.2.1/v1" }])
  );
}, 60_000);

afterAll(async () => {
  await proxy?.shutdown();
  restoreEnv?.();
}, 60_000);

describe("a fault that is SLOW rather than instant", () => {
  test("PRECONDITION P-3: a connect to TEST-NET-1 is still pending after 3s on this machine", async () => {
    // A captive portal or an aggressive corporate resolver answers 192.0.2.1,
    // which would silently turn the slow fault into a fast one. Fail loudly
    // with the measured duration; never skip.
    const started = Date.now();
    let outcome = "answered";
    try {
      await fetch("https://192.0.2.1/v1", { signal: AbortSignal.timeout(3_000) });
    } catch (err) {
      outcome = String(err);
    }
    const elapsed = Date.now() - started;
    expect(
      elapsed,
      `PRECONDITION P-3 FAILED: 192.0.2.1 settled in ${elapsed}ms (${outcome}). ` +
        "Something on this network answers TEST-NET-1, so the slow-connect fault is not in force."
    ).toBeGreaterThanOrEqual(2_800);
    expect(outcome).not.toBe("answered");
  }, 20_000);

  test("the request is held past the early rungs — a slow fault is not answered early", async () => {
    const controller = new AbortController();
    let answered = false;
    const request = postMessage(proxy.url, {
      model: "ep-slow@m-slow",
      signal: controller.signal,
    })
      .then(() => {
        answered = true;
      })
      .catch(() => {
        answered = true;
      });

    await sleep(12_000);
    expect(answered).toBe(false);
    controller.abort();
    await request;
  }, 40_000);

  test("the derived deadline bounds a SLOW attempt, not just a fast one", async () => {
    // Contract point 2: the budget is measured from inbound request start and
    // the client is answered inside it. An implementation that checks the
    // deadline only BETWEEN attempts satisfies every refusal-based test in
    // this suite and overruns here, because one attempt outlives the whole
    // budget. C-18 calls the missing piece PER_ATTEMPT_CONNECT_CAP_MS.
    const controller = new AbortController();
    let settledAt: number | null = null;
    const started = Date.now();
    const request = postMessage(proxy.url, {
      model: "ep-slow@m-slow",
      signal: controller.signal,
    })
      .then(() => {
        settledAt = Date.now() - started;
      })
      .catch(() => {
        settledAt = Date.now() - started;
      });

    const budget = DEADLINE_MS + 10_000;
    const watchUntil = Date.now() + budget;
    while (Date.now() < watchUntil && settledAt === null) await sleep(250);
    // Snapshot BEFORE aborting: a value recorded after the abort would be the
    // abort's own doing, not the proxy answering.
    const settledOnItsOwn = settledAt;
    controller.abort();
    await request;

    expect(
      settledOnItsOwn,
      `the client was still waiting ${budget}ms into a ${DEADLINE_MS}ms budget — ` +
        "one slow connect outlived the whole deadline"
    ).not.toBeNull();
    expect(settledOnItsOwn as unknown as number).toBeLessThan(budget);
  }, 90_000);
});
