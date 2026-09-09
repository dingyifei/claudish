import { describe, expect, test } from "bun:test";
import { INTERACTIVE_PROBE_TIMEOUT_MS, pinProbeModelSpec } from "./probe-runner.js";

describe("interactive provider probes", () => {
  test("leave enough time for refreshable OAuth and provider retry budgets", () => {
    expect(INTERACTIVE_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  test("pins provider-qualified probe model specs", () => {
    expect(pinProbeModelSpec({ provider: "grok-subscription", modelSpec: "grok-4.5" })).toBe(
      "grok-subscription@grok-4.5"
    );
  });
});
