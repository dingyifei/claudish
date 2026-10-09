/**
 * Containment — a bundled catalog row must never become bare-name reachable.
 *
 * This is the ONE invariant the feature's whole safety argument rests on.
 * Activation infers intent from an ambient env var (`PERPLEXITY_API_KEY`
 * exported for an unrelated script adds a picker row), and that is only
 * acceptable because the cost of the wrong inference is a picker row rather
 * than a request billed to a vendor the user never chose. The moment a catalog
 * name can be reached by typing a BARE model id, the inference can move money.
 *
 * Two doors, both pinned here:
 *
 *  1. `nativeModelPatterns` — the schema has no such field, so a row cannot
 *     declare one; asserted anyway against the live derived table, because the
 *     schema could gain one and the assertion is what would notice.
 *  2. `legacyPrefixes` — same shape.
 *
 * The shipped routing table was deleted. Catalog connections now decide which
 * providers may receive a bare name, so there is no third hand-written surface
 * to inspect here.
 */

import { describe, expect, test } from "bun:test";
import { PREDEFINED_ENDPOINTS } from "./predefined-catalog.js";
import { getLegacyPrefixPatterns, getNativeModelPatterns } from "./provider-definitions.js";

const catalogNames = PREDEFINED_ENDPOINTS.map((e) => e.name.toLowerCase());

describe("catalog containment", () => {
  test("the catalog is non-empty (or every assertion below is vacuous)", () => {
    expect(catalogNames.length).toBeGreaterThan(0);
    expect(new Set(catalogNames).size).toBe(catalogNames.length);
  });

  test("no catalog row declares nativeModelPatterns", () => {
    for (const row of PREDEFINED_ENDPOINTS) {
      expect(row).not.toHaveProperty("nativeModelPatterns");
    }
  });

  test("no catalog name owns a native model pattern", () => {
    const owners = new Set(getNativeModelPatterns().map((p) => p.provider.toLowerCase()));
    const leaked = catalogNames.filter((n) => owners.has(n));
    expect(leaked).toEqual([]);
  });

  test("no catalog name owns a legacy prefix", () => {
    const owners = new Set(getLegacyPrefixPatterns().map((p) => p.provider.toLowerCase()));
    const leaked = catalogNames.filter((n) => owners.has(n));
    expect(leaked).toEqual([]);
  });
});
