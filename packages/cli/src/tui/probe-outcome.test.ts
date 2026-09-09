// RoutingContent consumes this outcome: an unverified native Claude route must
// never appear as "no route"; running takes precedence, then any successful row.
import { expect, test } from "bun:test";
import { deriveProbeOutcome } from "./probe-outcome.js";
import type { ProbeEntry } from "./types.js";

function row(status: ProbeEntry["status"] | "unverified") {
  return { provider: "claude", displayName: "Claude", status };
}

test("derives the overall probe outcome without treating unverified routes as failures", () => {
  const unsuccessful = [row("failed"), row("skipped"), row("no_key")];

  for (const results of [
    [],
    [row("pending"), row("testing")],
    unsuccessful,
    [row("unverified")],
    [row("success")],
    [row("unverified"), row("success")],
  ]) {
    expect(deriveProbeOutcome("running", results)).toBe("running");
  }

  expect(deriveProbeOutcome("done", [row("success")])).toBe("routed");
  expect(deriveProbeOutcome("done", [...unsuccessful, row("success")])).toBe("routed");
  expect(deriveProbeOutcome("done", [row("unverified"), row("success")])).toBe("routed");
  expect(deriveProbeOutcome("done", [row("success"), row("unverified")])).toBe("routed");

  expect(deriveProbeOutcome("done", [row("unverified")])).toBe("unverified");
  expect(deriveProbeOutcome("done", [...unsuccessful, row("unverified")])).toBe("unverified");

  expect(deriveProbeOutcome("done", [])).toBe("no-route");
  expect(deriveProbeOutcome("done", unsuccessful)).toBe("no-route");
  for (const result of unsuccessful) {
    expect(deriveProbeOutcome("done", [result])).toBe("no-route");
  }
});
