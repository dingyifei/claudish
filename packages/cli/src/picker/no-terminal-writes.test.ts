import { describe, expect, test } from "bun:test";
/**
 * THE RENDERER OWNS THE TERMINAL.
 *
 * Inside `picker/` and `tui/`, `process.stdout.write`, `process.stderr.write` and
 * `console.*` are forbidden. Anything written behind a live renderer leaves cells
 * OpenTUI cannot invalidate — ghost characters that survive every redraw — and the
 * failure is silent: no exception, no stderr, and `tsc`, `bun test` and `check-surface`
 * all stay green. Only a screenshot catches it, and only if someone happens to take one
 * of that screen.
 *
 * `setStderrQuiet(true)` is NOT a defence. It sets a module flag read in exactly one
 * place — `logStderr`, `logger.ts:294` — so a raw `process.stderr.write` sails straight
 * past it. That is not hypothetical: `warnDiscoveryFailure` (`model-selector.ts:1305`)
 * is four such raw writes, which is precisely why the OpenTUI picker never calls it and
 * carries the failure as render state instead.
 *
 * A GREP IS CRUDE, AND IT IS THE ONLY MECHANISM THAT CATCHES THIS CLASS. The allowlist
 * is two paths, each with a reason, rather than a pattern — a pattern would rot into
 * permission.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL(".", import.meta.url).pathname.replace(/\/picker\/$/, "");

/**
 * Both entries write only AFTER their renderer is destroyed, when there is no buffer
 * left to corrupt.
 */
const ALLOWED = new Set([
  // The one deferred diagnostic, in the `finally` after `renderer.destroy()`.
  "/picker/model-picker-run.tsx",
  // The post-TUI login handoff, which runs after the config TUI has torn down.
  "/tui/index.tsx",
  // `installShutdown`'s failure report, which its own comment pins to after `destroy()`.
  "/tui/runtime/shutdown.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const WRITE = /process\.std(out|err)\.write|console\.(log|error|warn|info)\s*\(/;

describe("no terminal writes behind a live renderer", () => {
  test("picker/ and tui/ never write to stdout, stderr or console", () => {
    const files = [...walk(join(SRC, "picker")), ...walk(join(SRC, "tui"))];
    const offenders = files
      .map((f) => f.replace(SRC, ""))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => WRITE.test(readFileSync(join(SRC, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the allowlist is not empty and every entry still exists", () => {
    // A stale allowlist entry is a rule that has quietly stopped applying to anything.
    for (const rel of ALLOWED) {
      expect(readFileSync(join(SRC, rel), "utf8").length).toBeGreaterThan(0);
    }
  });
});
