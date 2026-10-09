/**
 * Ownership of CLAUDE_CODE_RETRY_WATCHDOG across nested claudish launches.
 *
 * claudish grants Claude Code's retry watchdog (~300 retries on a 503) only when
 * three gates hold: recovery enabled, recovery UI enabled, and this launch can
 * show a banner (`paneEligible`). Whenever it grants it, it also sets the
 * ownership marker CLAUDISH_SET_RETRY_WATCHDOG=1.
 *
 * The child environment starts as a copy of claudish's own, so a watchdog a
 * PARENT claudish granted reaches a nested claudish. A nested claudish whose own
 * gates fail must strip the parent's grant (both keys, absent) and must leave a
 * watchdog the USER set (no marker) exactly as it was.
 *
 * Written black-box from the spec (W1-W6) and the exported contract only.
 * Every test forces BOTH config gates explicitly so nothing depends on the
 * user's ~/.claudish config or CLAUDISH_RECOVERY* environment variables.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  RETRY_WATCHDOG_OWNER_ENV,
  applyRetryWatchdog,
  resetRecoveryFlagOverrides,
  setRecoveryFlagOverrides,
} from "./settings.js";

const WATCHDOG = "CLAUDE_CODE_RETRY_WATCHDOG";
const OWNER = "CLAUDISH_SET_RETRY_WATCHDOG";

type Env = Record<string, string | undefined>;

/** Keys that have nothing to do with the watchdog; W6 says none may change. */
function unrelated(): Env {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/qa",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:43123",
    API_TIMEOUT_MS: "60000",
    CLAUDISH_UNRELATED_FLAG: "1",
    EMPTY_VALUE: "",
  };
}

/** A parent claudish granted the watchdog: both keys inherited. */
function inheritedFromParent(): Env {
  return { ...unrelated(), [WATCHDOG]: "1", [OWNER]: "1" };
}

/** The user set the watchdog themselves: no ownership marker. */
function setByUser(): Env {
  return { ...unrelated(), [WATCHDOG]: "1" };
}

/** Neither key present. */
function clean(): Env {
  return { ...unrelated() };
}

type Gates = { recovery: boolean; recoveryUi: boolean; paneEligible: boolean };

/** Each way a single gate (or all of them) can fail. */
const FAILING_GATES: ReadonlyArray<[string, Gates]> = [
  ["paneEligible is false", { recovery: true, recoveryUi: true, paneEligible: false }],
  ["recovery is disabled", { recovery: false, recoveryUi: true, paneEligible: true }],
  ["the recovery UI is disabled", { recovery: true, recoveryUi: false, paneEligible: true }],
  ["every gate fails", { recovery: false, recoveryUi: false, paneEligible: false }],
];

function run(env: Env, gates: Gates): void {
  setRecoveryFlagOverrides({ recovery: gates.recovery, recoveryUi: gates.recoveryUi });
  applyRetryWatchdog(env, { paneEligible: gates.paneEligible });
}

beforeEach(() => {
  resetRecoveryFlagOverrides();
});

afterEach(() => {
  resetRecoveryFlagOverrides();
});

describe("contract", () => {
  test("RETRY_WATCHDOG_OWNER_ENV names the ownership marker CLAUDISH_SET_RETRY_WATCHDOG", () => {
    expect(RETRY_WATCHDOG_OWNER_ENV).toBe(OWNER);
  });
});

describe("W1: all three gates pass", () => {
  test("W1: grants the watchdog AND sets the ownership marker on a clean env", () => {
    const env = clean();

    run(env, { recovery: true, recoveryUi: true, paneEligible: true });

    expect(env[WATCHDOG]).toBe("1");
    expect(env[OWNER]).toBe("1");
    expect(env).toStrictEqual({ ...unrelated(), [WATCHDOG]: "1", [OWNER]: "1" });
  });

  test("W1: keeps both keys when a parent already granted them and this launch's gates also pass", () => {
    const env = inheritedFromParent();

    run(env, { recovery: true, recoveryUi: true, paneEligible: true });

    expect(env).toStrictEqual({ ...unrelated(), [WATCHDOG]: "1", [OWNER]: "1" });
  });
});

describe("W2: paneEligible fails with a watchdog inherited from a parent claudish", () => {
  test("W2: removes BOTH the watchdog and the marker (absent, not blanked)", () => {
    const env = inheritedFromParent();

    run(env, { recovery: true, recoveryUi: true, paneEligible: false });

    expect(Object.hasOwn(env, WATCHDOG)).toBe(false);
    expect(Object.hasOwn(env, OWNER)).toBe(false);
    expect(env).toStrictEqual(unrelated());
  });

  test("W2: the watchdog is not left as an empty string or '0'", () => {
    const env = inheritedFromParent();

    run(env, { recovery: true, recoveryUi: true, paneEligible: false });

    expect(env[WATCHDOG]).toBeUndefined();
    expect(env[OWNER]).toBeUndefined();
    expect(Object.keys(env)).not.toContain(WATCHDOG);
    expect(Object.keys(env)).not.toContain(OWNER);
  });
});

describe("W3: a gate fails and the USER set the watchdog (no marker)", () => {
  test.each(FAILING_GATES)(
    "W3: leaves the user's watchdog exactly as it was when %s",
    (_label, gates) => {
      const env = setByUser();

      run(env, gates);

      expect(env[WATCHDOG]).toBe("1");
      expect(Object.hasOwn(env, OWNER)).toBe(false);
      expect(env).toStrictEqual(setByUser());
    }
  );
});

describe("W4: a gate fails and neither key is present", () => {
  test.each(FAILING_GATES)("W4: adds nothing and changes nothing when %s", (_label, gates) => {
    const env = clean();

    run(env, gates);

    expect(Object.hasOwn(env, WATCHDOG)).toBe(false);
    expect(Object.hasOwn(env, OWNER)).toBe(false);
    expect(env).toStrictEqual(clean());
  });
});

describe("W5: a CONFIG gate fails (paneEligible true) with a watchdog inherited from a parent claudish", () => {
  test("W5: removes both keys when recovery is disabled", () => {
    const env = inheritedFromParent();

    run(env, { recovery: false, recoveryUi: true, paneEligible: true });

    expect(Object.hasOwn(env, WATCHDOG)).toBe(false);
    expect(Object.hasOwn(env, OWNER)).toBe(false);
    expect(env).toStrictEqual(unrelated());
  });

  test("W5: removes both keys when the recovery UI is disabled", () => {
    const env = inheritedFromParent();

    run(env, { recovery: true, recoveryUi: false, paneEligible: true });

    expect(Object.hasOwn(env, WATCHDOG)).toBe(false);
    expect(Object.hasOwn(env, OWNER)).toBe(false);
    expect(env).toStrictEqual(unrelated());
  });

  test("W5: removes both keys when both config gates fail", () => {
    const env = inheritedFromParent();

    run(env, { recovery: false, recoveryUi: false, paneEligible: true });

    expect(env).toStrictEqual(unrelated());
  });
});

describe("W6: unrelated keys are never touched", () => {
  const PASSING: Gates = { recovery: true, recoveryUi: true, paneEligible: true };
  const cases: ReadonlyArray<[string, () => Env, Gates]> = [
    ["all gates pass on a clean env", clean, PASSING],
    ["all gates pass on an inherited env", inheritedFromParent, PASSING],
    ["all gates pass on a user-set env", setByUser, PASSING],
    ...FAILING_GATES.flatMap(
      ([label, gates]): Array<[string, () => Env, Gates]> => [
        [`${label} on an inherited env`, inheritedFromParent, gates],
        [`${label} on a user-set env`, setByUser, gates],
        [`${label} on a clean env`, clean, gates],
      ]
    ),
  ];

  test.each(cases)("W6: every unrelated key keeps its value when %s", (_label, make, gates) => {
    const env = make();

    run(env, gates);

    const rest = { ...env };
    delete rest[WATCHDOG];
    delete rest[OWNER];
    expect(rest).toStrictEqual(unrelated());
  });
});
