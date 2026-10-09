// Pins the v3 reasoning-object regression: presence alone must not mark a model as thinking.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SlimModelEntry } from "./all-models-cache.js";
import { slimEntryToCatalogModel } from "./model-catalog.js";

interface CatalogFixture {
  entries: SlimModelEntry[];
}

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../test-fixtures/catalog-v3/rows-g-20260919013346169.json"),
    "utf-8"
  )
) as CatalogFixture;

function fixtureRow(modelId: string): SlimModelEntry {
  const entry = fixture.entries.find((candidate) => candidate.modelId === modelId);
  expect(entry, `fixture row ${modelId} should exist`).toBeDefined();
  return entry!;
}

describe("slimEntryToCatalogModel reasoning", () => {
  test("maps supported reasoning to thinking true", () => {
    const entry = fixtureRow("kimi-k3");
    expect(entry.reasoning?.supported).toBe(true);

    const model = slimEntryToCatalogModel(entry);

    expect(model.capabilities?.thinking).toBe(true);
  });

  test("maps explicitly unsupported reasoning to thinking false", () => {
    const entry = fixtureRow("gemini-omni-1.1-flash");
    expect(entry.reasoning?.supported).toBe(false);

    const model = slimEntryToCatalogModel(entry);

    expect(model.capabilities?.thinking).toBe(false);
  });

  test("omits thinking when reasoning is absent", () => {
    const entry = fixtureRow("gemini-flash-latest");
    expect("reasoning" in entry).toBe(false);

    const model = slimEntryToCatalogModel(entry);

    expect("thinking" in (model.capabilities ?? {})).toBe(false);
  });

  test("omits thinking when reasoning status is unknown", () => {
    const realEntry = fixtureRow("kimi-k3");
    expect(realEntry.reasoning?.supported).toBe(true);
    const entry: SlimModelEntry = { ...realEntry, reasoningStatus: "unknown" };
    expect(entry.reasoningStatus).toBe("unknown");

    const model = slimEntryToCatalogModel(entry);

    expect("thinking" in (model.capabilities ?? {})).toBe(false);
  });
});
