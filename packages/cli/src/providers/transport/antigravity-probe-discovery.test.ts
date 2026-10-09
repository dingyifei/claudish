import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AntigravityProviderTransport } from "./antigravity.js";

describe("Antigravity probe discovery", () => {
  // Mutation targets: antigravity.ts:364-365. Removing the method breaks the
  // proxy's capability check; dropping its third argument loses the exclusion set.
  test("exposes discoverProbeModel to the proxy route", () => {
    const transport = new AntigravityProviderTransport("gemini-3.8-flash");
    expect(typeof transport.discoverProbeModel).toBe("function");
  });

  test("forwards exclude to shared account-scoped discovery without a live API call", () => {
    const source = readFileSync(resolve(import.meta.dir, "antigravity.ts"), "utf-8");
    expect(source).toMatch(
      /discoverProbeModel\(exclude\?[^)]*\)[\s\S]*?discoverProviderProbeModel\(this\.name,\s*this\.displayName,\s*exclude\)/
    );
  });
});
