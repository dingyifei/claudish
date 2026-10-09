import { describe, expect, test } from "bun:test";
/**
 * The import-direction guard — four greps, each catching a class of mistake that `tsc`
 * compiles happily and that surfaces only as a slow MCP start or a runtime cycle.
 *
 * The rule:
 *
 *   `picker/` may import from `tui/`; `tui/` may NEVER import from `picker/`.
 *   `model-selector.ts` may reach `picker/` only through a dynamic `await import()`.
 *   `tui/hooks/` may never import from `tui/components/`.
 *
 * WHY A GREP AND NOT A TYPE. The hazard is not a compile error — it is a renderer
 * arriving in a process whose stdout is a protocol. `providers/model-ordering.ts:10-18`
 * records the same hazard for the inquirer picker and the fix it forced (moving one
 * comparator out to break the cycle); OpenTUI makes it worse, because the import graph
 * pulls a native library. Nothing in the type system expresses "this edge must be
 * dynamic", so the mechanism is text.
 *
 * THE FOURTH ASSERTION IS SCOPED TO TWO FILES BY NAME, and that is the point of it.
 * `can-draw-tui.ts` and `picker-cancelled.ts` are the two leaves `index.ts` and
 * `model-selector.ts` import STATICALLY; one OpenTUI import added to either would pull
 * the renderer into the cold-start graph with the other three guards still green. It is
 * scoped to those two files rather than to `tui/runtime/`, because that directory is
 * already occupied by `shutdown.ts` (which imports `node:os` and type-imports OpenTUI)
 * — a directory-wide assertion would have been RED on the commit that introduced it,
 * which is the same defect shape as a rule pointing at a file that does not exist.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL(".", import.meta.url).pathname.replace(/\/picker\/$/, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const read = (p: string): string => readFileSync(p, "utf8");

describe("import direction", () => {
  test("tui/ never imports from picker/, in any form", () => {
    const offenders = walk(join(SRC, "tui")).filter((f) => /from\s+"[^"]*picker\//.test(read(f)));
    expect(offenders.map((f) => f.replace(SRC, ""))).toEqual([]);
  });

  test("model-selector.ts reaches picker/ only through a dynamic import", () => {
    const src = read(join(SRC, "model-selector.ts"));
    // A STATIC import from this module into `picker/` is what would put OpenTUI on the
    // cold-start path — which is why `selectModelInteractive` uses `await import()`.
    expect(/^\s*import\s[^\n]*from\s+"\.\/picker\//m.test(src)).toBe(false);
    expect(src.includes('await import("./picker/model-picker-run.js")')).toBe(true);
  });

  test("tui/hooks/ never imports from tui/components/", () => {
    const hooks = join(SRC, "tui", "hooks");
    const offenders = walk(hooks).filter((f) => /from\s+"[^"]*\/components\//.test(read(f)));
    expect(offenders.map((f) => f.replace(SRC, ""))).toEqual([]);
  });

  test("the three statically-imported runtime leaves import NOTHING", () => {
    // Owed since phase 0, whose home for this assertion (`picker/`) did not exist yet.
    for (const leaf of ["can-draw-tui.ts", "picker-cancelled.ts", "should-open-picker.ts"]) {
      const src = read(join(SRC, "tui", "runtime", leaf));
      expect({ leaf, hasImport: /^\s*import\b/m.test(src) }).toEqual({ leaf, hasImport: false });
    }
  });
});
