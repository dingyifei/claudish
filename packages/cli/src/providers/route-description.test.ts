import { describe, expect, test } from "bun:test";
import {
  type CandidateOutcome,
  type RouteExplanation,
  describeRouteExplanation,
} from "./routing-rules.js";

function absentWithFallback(
  outcome: CandidateOutcome,
  displayName = "OpenRouter"
): RouteExplanation {
  return {
    requestedModel: "no-such-model-xyz",
    routedModel: "no-such-model-xyz",
    source: "catalog",
    catalog: "absent",
    candidates: [
      {
        provider: displayName.toLowerCase(),
        displayName,
        modelSpec: `${displayName.toLowerCase()}@no-such-model-xyz`,
        wireId: "no-such-model-xyz",
        position: "fallback",
        tier: "gateway",
        outcome,
      },
    ],
    outcome:
      outcome === "kept"
        ? { kind: "ok" }
        : {
            kind: "no-route",
            cause: outcome === "not-served" ? "not-served" : "no-credential",
            reason: "fixture has no route",
          },
    warnings: [],
  };
}

describe("describeRouteExplanation dropped fallback", () => {
  test("keeps fallback only for a fallback that was actually kept", () => {
    expect(describeRouteExplanation(absentWithFallback("kept"))).toBe(
      'catalog has no entry for "no-such-model-xyz" · fallback only'
    );
  });

  test.each([
    ["no-credential", "OpenRouter", "fallback OpenRouter has no credential"],
    [
      "credential-unreadable",
      "Antigravity",
      "fallback Antigravity has a credential that could not be read",
    ],
    ["not-served", "Antigravity", "fallback Antigravity does not serve it"],
    [
      "excluded-by-membership",
      "Kimi Coding",
      "fallback Kimi Coding is outside its plan's membership",
    ],
  ] as const)("words %s by its real outcome", (outcome, displayName, suffix) => {
    const line = describeRouteExplanation(absentWithFallback(outcome, displayName));

    expect(line).toBe(`catalog has no entry for "no-such-model-xyz" · ${suffix}`);
    expect(line).not.toContain("fallback only");
  });
});
