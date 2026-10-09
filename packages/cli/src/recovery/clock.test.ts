/**
 * The injectable clock.
 *
 * One property is being pinned, and it is the one every other recovery test
 * depends on: the ladder reads `recoveryClock()` at the moment it schedules,
 * so injecting a clock genuinely CONTROLS the schedule rather than merely
 * shadowing a value nobody consults. If that stops being true, the ladder tests
 * do not fail — they hang for the real 270-second deadline and are killed by
 * the runner, which reads as flakiness rather than as a defect.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { recoveryClock, resetRecoveryClock, setRecoveryClock } from "./clock.js";
import { closeAllEpisodes, joinEpisode } from "./coordinator.js";
import { FakeClock, drain } from "./test-helpers/fake-clock.js";

afterEach(() => {
  closeAllEpisodes();
  resetRecoveryClock();
});

describe("recovery clock", () => {
  test("defaults to the real clock, in PROCESS ms", () => {
    const before = performance.now();
    const t = recoveryClock().now();
    const after = performance.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
    // PROCESS ms, not epoch ms. Differencing the two units is the mistake the
    // separation exists to make unrepresentable, and epoch ms is ~1.8e12.
    expect(t).toBeLessThan(1e10);
  });

  test("setRecoveryClock installs, resetRecoveryClock restores", () => {
    const fake = new FakeClock(1234);
    setRecoveryClock(fake);
    expect(recoveryClock()).toBe(fake);
    expect(recoveryClock().now()).toBe(1234);
    resetRecoveryClock();
    expect(recoveryClock()).not.toBe(fake);
    // Back to a live reading rather than the fake's frozen 1234.
    const a = recoveryClock().now();
    expect(a).not.toBe(1234);
    expect(Math.abs(a - performance.now())).toBeLessThan(50);
  });

  test("the injected clock really drives the ladder timer", async () => {
    const fake = new FakeClock(0);
    setRecoveryClock(fake);
    const handle = joinEpisode({
      providerName: "clock-probe",
      providerDisplayName: "Clock Probe",
      endpoint: "http://127.0.0.1:9/v1",
      kind: "refused",
      code: "ConnectionRefused",
      reason: "unreachable",
      deadlineAt: 270_000,
    });

    let woke = false;
    const parked = handle.waitForNextAttempt(new AbortController().signal, 5_000).then(() => {
      woke = true;
    });
    await drain();

    // Armed on the FAKE clock, not the real one.
    expect(fake.pending()).toBe(1);
    expect(fake.pendingAt()).toEqual([5_000]);

    // Real time passing changes nothing: the gap is measured on the injected
    // clock alone.
    await drain(10);
    expect(woke).toBe(false);

    await fake.advance(4_999);
    expect(woke).toBe(false);
    await fake.advance(1);
    await parked;
    expect(woke).toBe(true);
    expect(fake.pending()).toBe(0);

    handle.leave();
  });

  test("unref is offered for the grace timer and is optional on the interface", () => {
    const fake = new FakeClock(0);
    setRecoveryClock(fake);
    const h = fake.setTimeout(() => {}, 10);
    recoveryClock().unref?.(h);
    expect(fake.unrefed.has(h as number)).toBe(true);

    // A clock without `unref` must not crash a caller. The real one has it;
    // the contract says optional, so the call site is `?.`-guarded.
    const minimal = {
      now: () => 0,
      setTimeout: () => 1,
      clearTimeout: () => {},
    };
    setRecoveryClock(minimal);
    expect(() => recoveryClock().unref?.(1)).not.toThrow();
  });
});
