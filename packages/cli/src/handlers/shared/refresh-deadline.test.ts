/**
 * Black-box tests for `refreshDeadlineAt`, written from the spec and the public
 * contract only (the implementation was not read).
 *
 * Spec:
 *   tier-1 budget = max(15000, min(API_TIMEOUT_MS ?? 360000, 300000) - 30000)
 *   A token-refresh failure is recovered against refreshDeadlineAt(deadlineAt),
 *   which reserves part of that budget for the request that follows.
 *
 *   REQ-1 (R1) default env: refreshDeadlineAt(270000) === 225000 (45 000 ms reserve)
 *   REQ-2 (R2) the reserve is never more than HALF the budget:
 *              75000 -> D - 22500, 60000 -> D - 15000, 30000 (floor) -> D - 7500
 *   REQ-3 (R3) refreshDeadlineAt(D) > D - budget for every case above
 *   REQ-4 (R4) API_TIMEOUT_MS=120000 (budget 90000) -> reserve exactly 45000,
 *              and it stays 45000 above that
 *   REQ-5 (contract) PER_ATTEMPT_CONNECT_CAP_MS is 45000; refreshDeadlineAt is pure
 *              apart from reading process.env.API_TIMEOUT_MS at call time
 */
import { afterEach, describe, expect, test } from "bun:test";
import { PER_ATTEMPT_CONNECT_CAP_MS, refreshDeadlineAt } from "./transient-retry.js";

const ORIGINAL_API_TIMEOUT_MS = process.env.API_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_API_TIMEOUT_MS === undefined) delete process.env.API_TIMEOUT_MS;
  else process.env.API_TIMEOUT_MS = ORIGINAL_API_TIMEOUT_MS;
});

function setApiTimeout(value: number | undefined): void {
  if (value === undefined) delete process.env.API_TIMEOUT_MS;
  else process.env.API_TIMEOUT_MS = String(value);
}

/** The spec's budget formula, restated from the spec text — not from the implementation. */
function specBudget(apiTimeoutMs: number | undefined): number {
  return Math.max(15_000, Math.min(apiTimeoutMs ?? 360_000, 300_000) - 30_000);
}

/** Reserve = how far before the tier-1 deadline the refresh deadline lands. */
function reservesAt(deadlines: readonly number[]): number[] {
  return deadlines.map((d) => d - refreshDeadlineAt(d));
}

/** The spec's own 270000, zero, and absolute epoch-millisecond deadlines like a live request's. */
const DEADLINES = [270_000, 0, 1_758_600_000_000, 1_758_600_045_000] as const;

const label = (v: number | undefined): string => (v === undefined ? "unset" : String(v));

describe("test-helper self-check: specBudget restates the spec's stated budgets", () => {
  test("budget is 270000 unset, 45000 at 75000, 30000 at 60000, 15000 at 45000 and below", () => {
    expect([undefined, 75_000, 60_000, 45_000, 30_000, 10_000].map(specBudget)).toEqual([
      270_000, 45_000, 30_000, 15_000, 15_000, 15_000,
    ]);
  });
});

describe("REQ-5 contract surface", () => {
  test("REQ-5: PER_ATTEMPT_CONNECT_CAP_MS is 45000", () => {
    expect(PER_ATTEMPT_CONNECT_CAP_MS).toBe(45_000);
  });

  test("REQ-5: refreshDeadlineAt returns the same value for the same deadline and environment", () => {
    setApiTimeout(75_000);

    const first = refreshDeadlineAt(1_758_600_000_000);
    const second = refreshDeadlineAt(1_758_600_000_000);

    expect(second).toBe(first);
  });

  test("REQ-5: refreshDeadlineAt reads API_TIMEOUT_MS at call time, not once at import", () => {
    const D = 1_758_600_000_000;
    const observed: number[] = [];

    for (const value of [60_000, 120_000, undefined, 30_000]) {
      setApiTimeout(value);
      observed.push(D - refreshDeadlineAt(D));
    }

    expect(observed).toEqual([15_000, 45_000, 45_000, 7_500]);
  });
});

describe("REQ-1 (R1): the default environment keeps the 45 000 ms reserve", () => {
  test("REQ-1: with API_TIMEOUT_MS unset, refreshDeadlineAt(270000) returns 225000", () => {
    setApiTimeout(undefined);

    expect(refreshDeadlineAt(270_000)).toBe(225_000);
  });

  test("REQ-1: with API_TIMEOUT_MS unset, the reserve is 45000 for every deadline", () => {
    setApiTimeout(undefined);

    expect(reservesAt(DEADLINES)).toEqual(DEADLINES.map(() => 45_000));
  });
});

describe("REQ-2 (R2): the reserve is capped at half the budget", () => {
  const exactCases: ReadonlyArray<{ api: number; budget: number; reserve: number }> = [
    { api: 75_000, budget: 45_000, reserve: 22_500 },
    { api: 60_000, budget: 30_000, reserve: 15_000 },
    { api: 30_000, budget: 15_000, reserve: 7_500 },
  ];

  for (const { api, budget, reserve } of exactCases) {
    test(`REQ-2: at API_TIMEOUT_MS=${api} (budget ${budget}) refreshDeadlineAt(D) === D - ${reserve}`, () => {
      setApiTimeout(api);

      expect(reservesAt(DEADLINES)).toEqual(DEADLINES.map(() => reserve));
    });
  }

  // Budget sits on the 15000 floor at 45000 "or below", so the floor reserve applies there too.
  for (const api of [45_000, 10_000]) {
    test(`REQ-2: at API_TIMEOUT_MS=${api} (budget on the 15000 floor) refreshDeadlineAt(D) === D - 7500`, () => {
      setApiTimeout(api);

      expect(reservesAt(DEADLINES)).toEqual(DEADLINES.map(() => 7_500));
    });
  }

  const sweep: ReadonlyArray<number | undefined> = [
    undefined,
    1_000,
    10_000,
    30_000,
    45_000,
    45_001,
    50_000,
    60_000,
    75_000,
    90_000,
    100_000,
    119_999,
    120_000,
    150_000,
    300_000,
    360_000,
    600_000,
  ];

  test("REQ-2: across API_TIMEOUT_MS values the reserve never exceeds half the budget", () => {
    const rows = sweep.map((api) => {
      setApiTimeout(api);
      const D = 1_758_600_000_000;
      const reserve = D - refreshDeadlineAt(D);
      return { api: label(api), withinHalf: reserve <= specBudget(api) / 2, reserve };
    });

    expect(rows.filter((r) => !r.withinHalf)).toEqual([]);
  });

  test("REQ-2: across API_TIMEOUT_MS values the auth path always keeps a positive budget", () => {
    const rows = sweep.map((api) => {
      setApiTimeout(api);
      const D = 1_758_600_000_000;
      const authBudget = refreshDeadlineAt(D) - (D - specBudget(api));
      return { api: label(api), positive: authBudget > 0, authBudget };
    });

    expect(rows.filter((r) => !r.positive)).toEqual([]);
  });
});

describe("REQ-3 (R3): the auth path's own budget is positive for every listed case", () => {
  const cases: ReadonlyArray<number | undefined> = [undefined, 75_000, 60_000, 30_000];

  for (const api of cases) {
    test(`REQ-3: at API_TIMEOUT_MS=${label(api)} refreshDeadlineAt(D) > D - budget(${specBudget(api)})`, () => {
      setApiTimeout(api);
      const budget = specBudget(api);

      const failures = DEADLINES.filter((d) => !(refreshDeadlineAt(d) > d - budget)).map((d) => ({
        D: d,
        refreshDeadline: refreshDeadlineAt(d),
        tierOneStart: d - budget,
      }));

      expect(failures).toEqual([]);
    });
  }
});

describe("REQ-4 (R4): the reserve saturates at 45000 from budget 90000 upward", () => {
  test("REQ-4: at API_TIMEOUT_MS=120000 (budget 90000) the reserve is exactly 45000", () => {
    setApiTimeout(120_000);

    expect(reservesAt(DEADLINES)).toEqual(DEADLINES.map(() => 45_000));
  });

  for (const api of [150_000, 200_000, 300_000, 360_000, 600_000]) {
    test(`REQ-4: at API_TIMEOUT_MS=${api} (budget ${specBudget(api)}) the reserve stays 45000`, () => {
      setApiTimeout(api);

      expect(reservesAt(DEADLINES)).toEqual(DEADLINES.map(() => 45_000));
    });
  }
});
