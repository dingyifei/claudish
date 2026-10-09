import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SlimModelEntry } from "./all-models-cache.js";
import { buildCatalogPageUrl, externalIdFor, isMovingPointer } from "./catalog-client.js";

interface CatalogFixture {
  entries: SlimModelEntry[];
}

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../test-fixtures/catalog-v3/rows-g-20260919013346169.json"),
    "utf-8"
  )
) as CatalogFixture;

function fixtureEntry(modelId: string): SlimModelEntry {
  const entry = fixture.entries.find((candidate) => candidate.modelId === modelId);
  if (!entry) throw new Error(`Fixture is missing ${modelId}`);
  return entry;
}

describe("catalog v3 exact wire ids", () => {
  // Mutation targets: catalog-client.ts:123 and :148-149. Dropping the latest
  // suffix rule breaks pointer classification; returning wireIds[0] selects the
  // Kimi pointer and makes the reduced-row assertion return it instead of null.
  test("selects an exact id instead of a moving pointer listed first", () => {
    expect(externalIdFor(fixtureEntry("kimi-k3"), "openrouter")).toBe("moonshotai/kimi-k3");
  });

  test("preserves a pointer when the canonical model id itself requests latest", () => {
    expect(externalIdFor(fixtureEntry("gemini-flash-latest"), "google")).toBe(
      "gemini-flash-latest"
    );
  });

  test.each([
    ["~moonshotai/kimi-latest", true],
    ["gemini-flash-latest", true],
    ["vendor/foo-latest", true],
    ["moonshotai/kimi-k3", false],
    ["k3", false],
    ["latest-model-x", false],
  ])("classifies %s as moving=%s", (wireId, expected) => {
    expect(isMovingPointer(wireId)).toBe(expected);
  });

  test("returns null when a pinned model has only a pointer connection", () => {
    const realKimi = fixtureEntry("kimi-k3");
    // This is the real Kimi fixture row reduced to its one OpenRouter pointer connection.
    const pointerOnly: SlimModelEntry = {
      ...realKimi,
      aggregators: realKimi.aggregators?.filter(
        (candidate) =>
          candidate.routeStatus === "mapped" &&
          candidate.route?.routeId === "openrouter" &&
          candidate.externalModelId === "~moonshotai/kimi-latest"
      ),
    };

    expect(externalIdFor(pointerOnly, "openrouter")).toBeNull();
  });
});

describe("catalog v3 page URL", () => {
  // Mutation targets: catalog-client.ts:257-258. Removing either set() drops a
  // required projection flag; URLSearchParams.set also proves existing keys are not duplicated.
  test.each([
    ["https://catalog.test/queryModels", undefined],
    ["https://catalog.test/queryModels?catalog=slim&status=active", "next-page"],
  ])("sets required parameters for %s", (baseUrl, cursor) => {
    const url = new URL(buildCatalogPageUrl(baseUrl, cursor, 1000));

    expect(url.searchParams.getAll("status")).toEqual(["all"]);
    expect(url.searchParams.getAll("includeRouteVariants")).toEqual(["true"]);
    expect(url.searchParams.get("catalog")).toBe(baseUrl.includes("catalog=") ? "slim" : null);
    expect(url.searchParams.get("cursor")).toBe(cursor ?? null);
  });
});
