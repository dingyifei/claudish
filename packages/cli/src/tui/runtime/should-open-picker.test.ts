/**
 * Tests for the model picker's launch gate — `shouldOpenPicker` and its exact
 * complement `requiresExplicitModel`.
 *
 * The subject is pure and total over five booleans, so the whole 2^5 = 32-cell
 * grid is enumerated against a HAND-WRITTEN table below rather than against a
 * re-statement of the implementation's own expression. The one cell the feature
 * exists for is `{interactive: true, tty: false}` — a piped or detached
 * `claudish` with no `--model`, which used to open a prompt into a stream nobody
 * reads and block on a keypress that could never arrive. It must not open the
 * picker, and it must not go quiet either: the complement has to fire so the run
 * gets the four actionable lines and exit 1.
 *
 * Written from the requirement (architecture §7, D6), not from the code.
 */

import { describe, expect, test } from "bun:test";
import {
  type ModelPickerGate,
  requiresExplicitModel,
  shouldOpenPicker,
} from "./should-open-picker.js";

/**
 * A grid row. The mask is five space-separated fields in a fixed order —
 * `interactive monitor model tiers tty` — each either the flag's letter (true) or
 * `-` (false). A typo in a mask throws rather than silently reading as false.
 */
type Row = [mask: string, open: boolean, needsExplicit: boolean];

const FIELDS = ["i", "m", "d", "p", "t"] as const;

function parse(mask: string): { gate: ModelPickerGate; tty: boolean } {
  const tokens = mask.split(" ");
  if (tokens.length !== FIELDS.length) throw new Error(`bad mask: ${mask}`);
  const bits = tokens.map((token, index) => {
    if (token === "-") return false;
    if (token === FIELDS[index]) return true;
    throw new Error(`bad mask field ${index} in "${mask}": ${token}`);
  });
  return {
    gate: {
      interactive: bits[0],
      monitor: bits[1],
      // A real spec string, because an empty string is falsy and would silently
      // test the "no model" cell instead of the "model given" one.
      model: bits[2] ? "or@deepseek/deepseek-r1" : undefined,
      hasProfileTiers: bits[3],
    },
    tty: bits[4],
  };
}

// i = interactive · m = --monitor · d = --model given · p = profile tiers · t = TTY
// Enumerated in binary order with `t` least significant, so every cell is present
// exactly once and the four interesting ones are annotated.
const GRID: Row[] = [
  ["- - - - -", false, true], // non-interactive, no screen, nothing configured → error
  ["- - - - t", false, true], // a terminal, but no human waiting (prompt came another way)
  ["- - - p -", false, false],
  ["- - - p t", false, false],
  ["- - d - -", false, false],
  ["- - d - t", false, false],
  ["- - d p -", false, false],
  ["- - d p t", false, false],
  ["- m - - -", false, false],
  ["- m - - t", false, false],
  ["- m - p -", false, false],
  ["- m - p t", false, false],
  ["- m d - -", false, false],
  ["- m d - t", false, false],
  ["- m d p -", false, false],
  ["- m d p t", false, false],
  ["i - - - -", false, true], // THE DEFECT CELL: piped/detached bare `claudish`
  ["i - - - t", true, false], // the only cell that opens the picker
  ["i - - p -", false, false],
  ["i - - p t", false, false],
  ["i - d - -", false, false],
  ["i - d - t", false, false],
  ["i - d p -", false, false],
  ["i - d p t", false, false],
  ["i m - - -", false, false],
  ["i m - - t", false, false],
  ["i m - p -", false, false],
  ["i m - p t", false, false],
  ["i m d - -", false, false],
  ["i m d - t", false, false],
  ["i m d p -", false, false],
  ["i m d p t", false, false],
];

describe("shouldOpenPicker / requiresExplicitModel — the 2^5 grid", () => {
  test("the grid is complete: 32 distinct cells", () => {
    expect(GRID).toHaveLength(32);
    expect(new Set(GRID.map(([mask]) => mask)).size).toBe(32);
  });

  for (const [mask, open, needsExplicit] of GRID) {
    test(`[${mask}] → open=${open} explicit=${needsExplicit}`, () => {
      const { gate, tty } = parse(mask);
      expect(shouldOpenPicker(gate, tty)).toBe(open);
      expect(requiresExplicitModel(gate, tty)).toBe(needsExplicit);
    });
  }

  test("no cell both skips the picker and stays silent about it", () => {
    for (const [mask] of GRID) {
      const { gate, tty } = parse(mask);
      // Independently derived from the mask, not from the module: a run needs a
      // model unless --monitor, --model or profile tiers already answered for it.
      const needsAModel = mask[2] === "-" && mask[4] === "-" && mask[6] === "-";
      const open = shouldOpenPicker(gate, tty);
      const explicit = requiresExplicitModel(gate, tty);
      if (needsAModel) {
        expect(open !== explicit).toBe(true); // exactly one, never both, never neither
      } else {
        expect(open).toBe(false);
        expect(explicit).toBe(false);
      }
    }
  });

  test("no TTY never opens the picker, whatever else is set", () => {
    let checked = 0;
    for (const [mask] of GRID) {
      const { gate } = parse(mask);
      expect(shouldOpenPicker(gate, false)).toBe(false);
      checked++;
    }
    expect(checked).toBe(32);
  });
});

/**
 * `advisorNativeSession` is the sixth input, and it is deliberately NOT a sixth
 * mask field: doubling the grid to 64 hand-written rows would bury the five that
 * describe real command lines. Instead it is pinned against `monitor`, whose 32
 * cells are already enumerated above — the claim the module's own comment makes.
 */
describe("advisorNativeSession — a reason no model is needed, exactly like --monitor", () => {
  test("over all 32 cells it is indistinguishable from --monitor", () => {
    let checked = 0;
    for (const [mask] of GRID) {
      const { gate, tty } = parse(mask);
      const viaMonitor = { ...gate, monitor: true, advisorNativeSession: false };
      const viaAdvisor = { ...gate, monitor: false, advisorNativeSession: true };
      expect(shouldOpenPicker(viaAdvisor, tty)).toBe(shouldOpenPicker(viaMonitor, tty));
      expect(requiresExplicitModel(viaAdvisor, tty)).toBe(requiresExplicitModel(viaMonitor, tty));
      checked++;
    }
    expect(checked).toBe(32);
  });

  test("`--advisor` on a terminal asks nothing and errors about nothing", () => {
    // The regression this guards: Claude Code picks its own model for a native
    // advisor session, so demanding --model would make a working command fail.
    const gate: ModelPickerGate = { interactive: true, advisorNativeSession: true };
    expect(shouldOpenPicker(gate, true)).toBe(false);
    expect(requiresExplicitModel(gate, true)).toBe(false);
  });

  test("the complement law still holds with the advisor term set", () => {
    for (const [mask] of GRID) {
      const { gate, tty } = parse(mask);
      const advisor = { ...gate, advisorNativeSession: true };
      // No model is ever needed once the advisor term is on, so BOTH gates must
      // be false — never "skip the picker silently and demand a model anyway".
      expect(shouldOpenPicker(advisor, tty)).toBe(false);
      expect(requiresExplicitModel(advisor, tty)).toBe(false);
    }
  });
});

describe("shouldOpenPicker — the invocations these cells stand for", () => {
  /** What `cli.ts` produces for each real command line, plus `canDrawTui()`. */
  const tty = true;
  const piped = false;

  test("bare `claudish` at a terminal opens the picker", () => {
    const gate: ModelPickerGate = { interactive: true, monitor: false };
    expect(shouldOpenPicker(gate, tty)).toBe(true);
    expect(requiresExplicitModel(gate, tty)).toBe(false);
  });

  test("`claudish < /dev/null` fails fast instead of prompting", () => {
    // cli.ts sets interactive=true here: no positional prompt, no --stdin, no -p.
    const gate: ModelPickerGate = { interactive: true, monitor: false };
    expect(shouldOpenPicker(gate, piped)).toBe(false);
    expect(requiresExplicitModel(gate, piped)).toBe(true);
  });

  test("`claudish -p` keeps its existing behaviour: no picker, explicit model required", () => {
    // _hasPrintFlag stops cli.ts's interactive default, so the picker was already
    // excluded here before this gate existed — and headless-vs-interactive.md is
    // why that must stay: `-p --input-format stream-json` turns a wrong flag into
    // silence and exit 0.
    const gate: ModelPickerGate = { interactive: false, monitor: false };
    expect(shouldOpenPicker(gate, tty)).toBe(false);
    expect(requiresExplicitModel(gate, tty)).toBe(true);
  });

  test("a positional prompt keeps its existing behaviour too", () => {
    const gate: ModelPickerGate = { interactive: false, monitor: false };
    expect(shouldOpenPicker(gate, tty)).toBe(false);
    expect(requiresExplicitModel(gate, tty)).toBe(true);
  });

  test("`--model` piped asks nothing and errors about nothing", () => {
    const gate: ModelPickerGate = { interactive: true, model: "gk@grok-4-latest" };
    expect(shouldOpenPicker(gate, piped)).toBe(false);
    expect(requiresExplicitModel(gate, piped)).toBe(false);
  });

  test("`--monitor` piped asks nothing and errors about nothing", () => {
    const gate: ModelPickerGate = { interactive: true, monitor: true };
    expect(shouldOpenPicker(gate, piped)).toBe(false);
    expect(requiresExplicitModel(gate, piped)).toBe(false);
  });

  test("profile tiers piped ask nothing and error about nothing", () => {
    // Claude Code resolves opus/sonnet/haiku/subagent internally, so claudish
    // needs no single model — the case that must not be turned into exit 1.
    const gate: ModelPickerGate = { interactive: true, hasProfileTiers: true };
    expect(shouldOpenPicker(gate, piped)).toBe(false);
    expect(requiresExplicitModel(gate, piped)).toBe(false);
  });

  test("an absent field reads as false, so a partial gate cannot open the picker", () => {
    expect(shouldOpenPicker({}, tty)).toBe(false);
    expect(requiresExplicitModel({}, tty)).toBe(true);
  });
});
