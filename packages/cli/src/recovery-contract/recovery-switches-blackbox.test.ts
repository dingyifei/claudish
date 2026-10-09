/**
 * CONTRACT POINT 8 — three switches (CLI flag, env var, config field) and their
 * precedence: flag > env > project config > global config > default(on).
 *
 * The env arm lives in recovery-ladder-blackbox.test.ts (with its own paired
 * control). This file covers the two CONFIG scopes, their precedence against
 * the env var, and the invariant that costs a config field its life:
 * a `ClaudishProfileConfig` field missing from `loadConfig`'s allowlist
 * survives on disk until the first global save and is then silently dropped.
 * Every other switch test passes right up to that save.
 *
 * Each arm takes a fresh endpoint: a recovery episode is per-endpoint and
 * outlives the request that opened it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../config-override.js";
import { loadConfig, saveConfig } from "../profile-config.js";
import {
  type FixturePool,
  type ProxyHandle,
  createRawFixturePool,
  endpointsConfig,
  envSnapshot,
  postMessage,
  sleep,
  startProxy,
} from "./fixtures.js";

const API_TIMEOUT_MS = 40_000; // ⇒ 10s deadline ⇒ attempts at 0s, 5s

let restoreEnv: () => void;
let proxy: ProxyHandle;
let pool: FixturePool;
let projectDir: string;
let originalCwd: string;

beforeAll(async () => {
  restoreEnv = envSnapshot(["API_TIMEOUT_MS", "CLAUDISH_RECOVERY", "CLAUDISH_RECOVERY_UI"]);
  process.env.API_TIMEOUT_MS = String(API_TIMEOUT_MS);
  delete process.env.CLAUDISH_RECOVERY;

  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), "recovery-project-"));

  pool = createRawFixturePool(8, "ep-switch");
  proxy = await startProxy(endpointsConfig(pool.specs));

  // Warm-up: the FIRST request through a fresh proxy pays one-time catalog and
  // registry latching (~3s), which would otherwise be charged to whichever
  // "answers immediately" assertion happened to run first. The header keeps the
  // warm-up itself out of the ladder.
  const warm = pool.next();
  await postMessage(proxy.url, {
    model: warm.model,
    headers: { "x-claudish-no-recovery": "1" },
  });
}, 60_000);

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(join(projectDir, ".claudish.json"), { force: true });
  delete process.env.CLAUDISH_RECOVERY;
});

afterAll(async () => {
  process.chdir(originalCwd);
  await proxy?.shutdown();
  pool?.stopAll();
  rmSync(projectDir, { recursive: true, force: true });
  restoreEnv?.();
});

function writeProjectConfig(value: unknown): void {
  writeFileSync(join(projectDir, ".claudish.json"), JSON.stringify(value), "utf8");
  process.chdir(projectDir);
}

/** Did the ladder run? Answered at the fixture's socket, with a bounded wait. */
async function ladderRan(headers?: Record<string, string>): Promise<{
  attempts: number;
  elapsedMs: number;
  status: number;
}> {
  const { model, fixture } = pool.next();
  const result = await postMessage(proxy.url, { model, headers });
  return {
    attempts: fixture.connections.length,
    elapsedMs: result.elapsedMs,
    status: result.status,
  };
}

describe("CP-8 — the config switches", () => {
  test("project config recovery.enabled=false ⇒ one attempt, immediate answer", async () => {
    writeProjectConfig({ recovery: { enabled: false } });
    const run = await ladderRan();
    expect(run.attempts).toBe(1);
    expect(run.elapsedMs).toBeLessThan(2_000);
    expect(run.status).toBe(400);
  }, 30_000);

  test("PAIRED CONTROL: the same project file with the field removed ⇒ the ladder runs", async () => {
    writeProjectConfig({ someUnrelatedKey: true });
    const run = await ladderRan();
    expect(run.attempts).toBeGreaterThanOrEqual(2);
    expect(run.elapsedMs).toBeGreaterThan(4_000);
  }, 30_000);

  test("an explicit project ON beats a project-scope absence and keeps the ladder", async () => {
    writeProjectConfig({ recovery: { enabled: true } });
    const run = await ladderRan();
    expect(run.attempts).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("the env var beats the project config", async () => {
    // Documented precedence: flag > env > project > global > default(on).
    writeProjectConfig({ recovery: { enabled: true } });
    process.env.CLAUDISH_RECOVERY = "0";
    const run = await ladderRan();
    expect(run.attempts).toBe(1);
    expect(run.elapsedMs).toBeLessThan(2_000);
  }, 30_000);

  test("an empty object in the project scope is 'no opinion', not 'off'", async () => {
    writeProjectConfig({ recovery: {} });
    const run = await ladderRan();
    expect(run.attempts).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("a garbage value does not silently disable recovery", async () => {
    writeProjectConfig({ recovery: { enabled: "maybe" } });
    const run = await ladderRan();
    expect(run.attempts).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe("CP-8 — the switch survives a config save", () => {
  test("recovery and recoveryUi are still on disk after load → save", async () => {
    // The recorded failure mode: a field absent from loadConfig's allowlist
    // lives on disk until the first global save and is then dropped with no
    // error. Every behavioural switch test above passes right up to that save.
    const dir = mkdtempSync(join(tmpdir(), "recovery-save-"));
    const file = join(dir, "config.json");
    writeFileSync(
      file,
      JSON.stringify({
        recovery: { enabled: false },
        recoveryUi: { enabled: false },
        stats: { enabled: false },
      }),
      "utf8"
    );
    setConfigFileOverride(file);
    try {
      const loaded = loadConfig();
      expect(loaded.recovery).toEqual({ enabled: false });
      expect(loaded.recoveryUi).toEqual({ enabled: false });

      saveConfig(loaded);
      await sleep(10);

      const onDisk = JSON.parse(readFileSync(file, "utf8"));
      expect(onDisk.recovery).toEqual({ enabled: false });
      expect(onDisk.recoveryUi).toEqual({ enabled: false });
    } finally {
      setConfigFileOverride(null);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
