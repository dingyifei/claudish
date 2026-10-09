/**
 * The CLAUDE.md silent-drop invariant, discharged for the two recovery fields.
 *
 * > A new `ClaudishProfileConfig` field MUST be added to `loadConfig`'s
 * > allowlist in `profile-config.ts`; otherwise it survives on disk until the
 * > first global save and is then dropped.
 *
 * `loadConfig` is a HAND-WRITTEN allowlist, not a spread, so a field absent
 * from it round-trips to nothing. The failure is silent in the worst way: the
 * user's setting works until some unrelated code path calls
 * `saveConfig(loadConfig())` — the config TUI saving any other setting will do
 * — and is then erased with no error. For `recovery.enabled: false` that means
 * a deliberate OFF-SWITCH silently turning back ON.
 *
 * The trap has caught this codebase twice before (`onepasswordEnvironments`,
 * then `keychain`), which is why the round-trip is pinned the moment the field
 * is defined rather than the moment it is first consumed.
 *
 * Hermetic via `--config`'s own override seam, which is what `bun run
 * test:safe` relies on to stay off the real machine file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "./config-override.js";
import { loadConfig, saveConfig } from "./profile-config.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-recovery-roundtrip-"));
  file = join(dir, "config.json");
  setConfigFileOverride(file);
});

afterEach(() => {
  setConfigFileOverride(null);
  rmSync(dir, { recursive: true, force: true });
});

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

describe("saveConfig(loadConfig()) round-trip", () => {
  test("preserves recoveryUi", () => {
    writeFileSync(
      file,
      JSON.stringify({ openRouterApiKey: "sk-test", recoveryUi: { enabled: false } })
    );

    // Exactly what the config TUI does when it saves any unrelated setting.
    saveConfig(loadConfig());

    expect(onDisk().recoveryUi).toEqual({ enabled: false });
  });

  test("preserves recovery (the master switch) — an off-switch must not turn itself on", () => {
    writeFileSync(
      file,
      JSON.stringify({ openRouterApiKey: "sk-test", recovery: { enabled: false } })
    );
    saveConfig(loadConfig());
    expect(onDisk().recovery).toEqual({ enabled: false });
  });

  test("survives repeated save/load cycles, which is how the drop actually shows up", () => {
    writeFileSync(
      file,
      JSON.stringify({ recovery: { enabled: false }, recoveryUi: { enabled: true } })
    );
    for (let i = 0; i < 3; i++) saveConfig(loadConfig());
    expect(onDisk().recovery).toEqual({ enabled: false });
    expect(onDisk().recoveryUi).toEqual({ enabled: true });
  });

  test("an empty object survives too — `{}` is a meaningful value, not an absence", () => {
    // `{}` means "no opinion, fall through to the next scope". Dropping it is
    // a smaller bug than dropping `{enabled:false}` but it is the same bug,
    // and an allowlist entry guarded on truthiness rather than on
    // `!== undefined` would drop exactly this shape.
    writeFileSync(file, JSON.stringify({ recoveryUi: {} }));
    saveConfig(loadConfig());
    expect(onDisk().recoveryUi).toEqual({});
  });

  test("absent stays absent — the allowlist must not invent a default onto disk", () => {
    writeFileSync(file, JSON.stringify({ openRouterApiKey: "sk-test" }));
    saveConfig(loadConfig());
    const disk = onDisk();
    expect("recovery" in disk).toBe(false);
    expect("recoveryUi" in disk).toBe(false);
  });

  test("the sibling fields it sits beside still round-trip, so the allowlist was not disturbed", () => {
    writeFileSync(
      file,
      JSON.stringify({
        openRouterApiKey: "sk-test",
        proOnUltracode: true,
        recoveryUi: { enabled: false },
      })
    );
    saveConfig(loadConfig());
    expect(onDisk().proOnUltracode).toBe(true);
    expect(onDisk().recoveryUi).toEqual({ enabled: false });
  });
});
