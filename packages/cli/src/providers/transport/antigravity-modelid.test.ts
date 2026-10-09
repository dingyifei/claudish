import { describe, expect, test } from "bun:test";
import { resolveAntigravityModelId } from "./antigravity.js";

/**
 * resolveAntigravityModelId operates ONLY on the account's dynamic models catalog (no hardcoded
 * model ids). Every case injects its own servedIds + defaultId, so the tests
 * carry no pinned model list and touch no network.
 */
describe("resolveAntigravityModelId", () => {
  test("returns an exactly-served id untouched", () => {
    const served = ["gemini-3.6-flash-high", "gemini-2.5-flash"];
    expect(resolveAntigravityModelId("gemini-2.5-flash", served, null)).toBe("gemini-2.5-flash");
    expect(
      resolveAntigravityModelId("gemini-3.6-flash-high", served, "gemini-3.6-flash-high")
    ).toBe("gemini-3.6-flash-high");
  });

  test("prefers the backend default when it is one of the family variants", () => {
    const served = ["gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-2.5-flash"];
    expect(resolveAntigravityModelId("gemini-3.6-flash", served, "gemini-3.6-flash-high")).toBe(
      "gemini-3.6-flash-high"
    );
    // Default can be a weaker tier — it still wins because the backend chose it.
    expect(resolveAntigravityModelId("gemini-3.6-flash", served, "gemini-3.6-flash-medium")).toBe(
      "gemini-3.6-flash-medium"
    );
  });

  test("falls back to the strongest reasoning tier when there is no usable default", () => {
    const served = ["gemini-3.6-flash-medium", "gemini-3.6-flash-low"];
    // No default → rank rule picks the strongest served tier (medium > low here).
    expect(resolveAntigravityModelId("gemini-3.6-flash", served, null)).toBe(
      "gemini-3.6-flash-medium"
    );
  });

  test("ignores a default that is not a variant of the requested family", () => {
    const served = ["gemini-3.6-flash-low", "gemini-3.6-flash-high"];
    // Default belongs to a different family → rank rule applies (high wins).
    expect(resolveAntigravityModelId("gemini-3.6-flash", served, "gemini-3.1-pro-high")).toBe(
      "gemini-3.6-flash-high"
    );
  });

  test("orders tiers high > medium > low > extra-low > tiered", () => {
    expect(
      resolveAntigravityModelId(
        "gemini-x",
        [
          "gemini-x-tiered",
          "gemini-x-extra-low",
          "gemini-x-low",
          "gemini-x-medium",
          "gemini-x-high",
        ],
        null
      )
    ).toBe("gemini-x-high");
    expect(
      resolveAntigravityModelId("gemini-x", ["gemini-x-tiered", "gemini-x-extra-low"], null)
    ).toBe("gemini-x-extra-low");
    expect(
      resolveAntigravityModelId("gemini-x", ["gemini-x-low", "gemini-x-extra-low"], null)
    ).toBe("gemini-x-low");
  });

  test("prefers a ranked tier over an unrecognized suffix", () => {
    const served = ["gemini-3.6-flash-experimental", "gemini-3.6-flash-low"];
    expect(resolveAntigravityModelId("gemini-3.6-flash", served, null)).toBe(
      "gemini-3.6-flash-low"
    );
  });

  test("returns the sole served variant even if its suffix is unrecognized", () => {
    const served = ["gemini-3.6-flash-experimental"];
    expect(resolveAntigravityModelId("gemini-3.6-flash", served, null)).toBe(
      "gemini-3.6-flash-experimental"
    );
  });

  test("passes an unknown family through unchanged (backend 404 → F1–F7 rewrite)", () => {
    const served = ["gemini-3.6-flash-high", "gemini-2.5-flash"];
    expect(resolveAntigravityModelId("gemini-9.9-ultra", served, null)).toBe("gemini-9.9-ultra");
    // Empty dynamic models catalog (fetch failed) → also passthrough.
    expect(resolveAntigravityModelId("gemini-3.6-flash", [], null)).toBe("gemini-3.6-flash");
  });

  test("trims surrounding whitespace before matching", () => {
    const served = ["gemini-2.5-flash"];
    expect(resolveAntigravityModelId("  gemini-2.5-flash  ", served, null)).toBe(
      "gemini-2.5-flash"
    );
  });
});
