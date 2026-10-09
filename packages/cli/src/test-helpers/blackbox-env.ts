/**
 * Isolation harness for the BLACK-BOX behaviour suite (`*.blackbox.test.ts`).
 *
 * Those files were written by an external model that never saw this repository's
 * implementation — only the spec, the acceptance criteria and `.d.ts` contracts
 * with every body stripped. This module is the only part of that delivery that
 * was rewritten on integration, and it was rewritten for one reason: the
 * original relocated `HOME` and replaced `globalThis.fetch` at MODULE LOAD and
 * restored them only at `process.once("exit")`.
 *
 * That is correct inside a sandbox holding seven files and wrong inside a
 * 231-file suite. Bun's test runner shares one process across every test file —
 * the same property that makes `mock.module()` bleed here — so a process-wide
 * `HOME` swap changes what every LATER file sees, and several modules snapshot
 * their paths at module scope (`profile-config.ts:18`,
 * `all-models-cache.ts:102`), so the swap would also be invisible to the very
 * readers it was meant to redirect. A permanently throwing `fetch` would take
 * the live-API tests with it.
 *
 * So the isolation is FILE-SCOPED: `useBlackboxEnv()` installs in `beforeAll`
 * and uninstalls in `afterAll`. The writer's two guarantees are kept intact —
 * no real user state, and a fail-closed network tripwire whose `afterEach`
 * check catches even an implementation that swallows the rejection.
 *
 * Config reads are isolated through the repo's own seam
 * (`setConfigFileOverride`) rather than through `HOME`, because the module-level
 * snapshot above means a relocated `HOME` cannot reach `loadConfig()` at all.
 */
import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A cold, generated HOME. Never the developer's. */
export const sandboxHome = mkdtempSync(join(tmpdir(), "claudish-blackbox-home-"));
mkdirSync(join(sandboxHome, ".claudish"), { recursive: true });

/**
 * The writer's contract also named a variable that switched off an on-disk
 * store of the dynamic models catalog. It is deliberately NOT here: that store
 * was deleted in `fe8722e`, and the variable with it.
 */
const RELOCATED: Record<string, string> = {
  HOME: sandboxHome,
  USERPROFILE: sandboxHome,
  XDG_CONFIG_HOME: join(sandboxHome, ".config"),
  CLAUDISH_DISABLE_KEYCHAIN: "1",
  CLAUDISH_DISABLE_OP: "1",
};

const saved = new Map<string, string | undefined>();
let realFetch: typeof globalThis.fetch | null = null;
const attemptedFetches: string[] = [];

function install(): void {
  if (realFetch) return;
  for (const [name, value] of Object.entries(RELOCATED)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  realFetch = globalThis.fetch;
  const tripwire = async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string })?.url ?? "unknown");
    attemptedFetches.push(`Unexpected network access: ${url}`);
    throw new Error("Black-box QA forbids network access");
  };
  // `preconnect` is a Bun/undici extension on the real `fetch`; carry it over so
  // the replacement is structurally a `fetch` and nothing downstream throws on a
  // missing property before the tripwire can record the attempt.
  tripwire.preconnect = realFetch.preconnect;
  globalThis.fetch = tripwire as unknown as typeof fetch;
}

function uninstall(): void {
  if (!realFetch) return;
  globalThis.fetch = realFetch;
  realFetch = null;
  for (const [name, value] of saved) restoreEnv(name, value);
  saved.clear();
}

/**
 * Install the isolation for the CALLING test file. Call it once, at the top of
 * the file, before any `describe`.
 */
export function useBlackboxEnv(): void {
  beforeAll(install);
  afterEach(() => {
    const attempts = attemptedFetches.splice(0);
    expect(attempts).toEqual([]);
  });
  afterAll(uninstall);
}

process.once("exit", () => {
  uninstall();
  rmSync(sandboxHome, { recursive: true, force: true });
});

/** A fresh scratch directory under the sandbox HOME. */
export function scratchDirectory(label: string): string {
  return mkdtempSync(join(sandboxHome, `${label}-`));
}

/** Put one environment variable back exactly as it was, absent included. */
export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
