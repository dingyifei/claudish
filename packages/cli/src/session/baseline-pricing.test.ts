import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "claudish-stage8-baselines-"));
const cacheDir = join(home, ".claudish");
const cachePath = join(cacheDir, "cloud-models-catalog-v3.json");

mkdirSync(cacheDir, { recursive: true });
writeFileSync(
  cachePath,
  JSON.stringify({
    version: 3,
    catalogGenerationId: "stage8-baseline-fixture",
    lastUpdated: "2026-09-24T00:00:00.000Z",
    entries: [
      {
        modelId: "claude-opus-stage8",
        aliases: ["~anthropic/claude-opus-latest"],
        aggregators: [
          {
            sourceProviderId: "native-anthropic",
            sourceCollectorId: "stage8-fixture",
            confidence: "scrape_verified",
            routeStatus: "mapped",
            route: { routeId: "anthropic", routeProfileId: "claude-code-subscription" },
            externalModelId: "claude-opus-stage8",
            pricing: { type: "flat", input: 1, output: 2 },
          },
          {
            sourceProviderId: "openrouter",
            sourceCollectorId: "stage8-fixture",
            confidence: "aggregator_reported",
            routeStatus: "mapped",
            route: { routeId: "openrouter", routeProfileId: "gateway" },
            externalModelId: "anthropic/claude-opus-stage8",
            pricing: { type: "flat", input: 10, output: 50 },
          },
          {
            sourceProviderId: "anthropic",
            sourceCollectorId: "stage8-fixture",
            confidence: "api_official",
            routeStatus: "mapped",
            route: { routeId: "anthropic", routeProfileId: "direct-api" },
            externalModelId: "claude-opus-stage8",
            pricing: { type: "flat", input: 5, output: 25 },
          },
        ],
      },
      {
        modelId: "claude-sonnet-stage8",
        aliases: ["~anthropic/claude-sonnet-latest"],
        aggregators: [
          {
            sourceProviderId: "anthropic",
            sourceCollectorId: "stage8-fixture",
            confidence: "api_official",
            routeStatus: "mapped",
            route: { routeId: "anthropic", routeProfileId: "direct-api" },
            externalModelId: "claude-sonnet-stage8",
            pricing: { type: "unavailable" },
          },
        ],
      },
    ],
    models: [],
    plans: [],
  }),
  "utf8"
);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("baseline pricing catalog reads", () => {
  test("uses Anthropic direct-api pricing and omits unavailable tiers", () => {
    const moduleUrl = new URL("./baseline-pricing.ts", import.meta.url).href;
    const script = `
      const { getBaselines } = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(JSON.stringify(getBaselines()));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, "../../../.."),
      env: {
        ...process.env,
        HOME: home,
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    expect(result.exitCode, stderr || stdout).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        modelId: "claude-opus-stage8",
        label: "Opus",
        inputPerM: 5,
        outputPerM: 25,
      },
    ]);
  });
});
