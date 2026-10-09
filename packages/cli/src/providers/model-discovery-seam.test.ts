import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ModelDiscoveryFetcher } from "./model-discovery.js";
import { getModelDiscoveryFetcher, registerModelDiscoveryFetcher } from "./model-discovery.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(async () => {
    throw new Error("model-discovery seam tests must not access the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("model discovery fetcher registration", () => {
  test("returns the registered fetcher and lets the last writer win", () => {
    const firstFetcher: ModelDiscoveryFetcher = async () => ({ kind: "models", models: [] });
    const replacementFetcher: ModelDiscoveryFetcher = async () => ({
      kind: "models",
      models: [{ id: "replacement-model" }],
    });

    registerModelDiscoveryFetcher("test-format", firstFetcher);
    expect(getModelDiscoveryFetcher("test-format")).toBe(firstFetcher);

    // Last-writer-wins lets tests and later registrations replace a format without shared mocks.
    registerModelDiscoveryFetcher("test-format", replacementFetcher);
    expect(getModelDiscoveryFetcher("test-format")).toBe(replacementFetcher);
  });

  test("returns undefined for an unregistered format", () => {
    expect(getModelDiscoveryFetcher("nope")).toBeUndefined();
  });

  test("the builtin module registers every non-GET discovery format", async () => {
    // Importing this lazy bundle performs registration while keeping the protobuf codec off cold start.
    await import("./model-discovery-builtins.js");

    for (const format of ["devin-connect", "antigravity", "ollama-tags"]) {
      expect(typeof getModelDiscoveryFetcher(format)).toBe("function");
    }
  });
});
