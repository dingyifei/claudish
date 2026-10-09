/**
 * viz/tokens.ts — the semantic palette. Hex is the public dialect.
 *
 * Vendored from the `bunjs:opentui-tui` skill's `assets/theme/tokens.ts`, with TWO
 * deliberate deviations from the shipped file. Everything else — the token NAMES, the
 * `Ramp` type and its non-empty bound, the ramp STRUCTURE (an explicit midtone stop so
 * `blendStops` never desaturates through the middle) — is unchanged. `color.ts` and
 * `text.ts` beside it are byte-identical copies; `widgets.tsx` carries four ADDITIVE
 * changes, each documented at its own definition and none altering shipped behaviour:
 * `Panel`'s `flush` prop, the `<span>` twins `MeterSpan` / `SparklineSpan` (with
 * `sparkGlyphs` extracted so the twin cannot drift from `Sparkline`), and `BadgeChip`'s
 * optional `fg`, for a chip whose fill WE chose and whose ink is therefore ours too. The twins exist for
 * the reason the file already gives for `BadgeSpan` — a `<text>` cannot nest in a `<text>`,
 * so every ONE-`<text>` widget is un-composable in a mixed row, and the alternative, flex
 * `<text>` siblings, is the arrangement Yoga silently shrinks. Never scatter hex
 * literals in components: import a token. If a value you need is missing, add a token
 * HERE first — a one-off literal in a component is how a palette stops being a palette.
 *
 * DEVIATION 1 — THE HEXES ARE CLAUDISH'S, NOT THE SKILL'S DEFAULTS.
 * The skill ships a Catppuccin-ish palette; claudish already has one — the btop-inspired
 * neon-on-true-black `C` in `../theme.ts`, which the config TUI, the probe TUI and the
 * static probe results printer all render from. Two palettes in one process would break
 * the skill's own rule 1 ("a colour means ONE thing app-wide") and rule 5 ("one border
 * style, one accent"), and would make the new session surfaces look like a different
 * program from `claudish --probe`. So this file is an ADAPTER: it keeps the skill's
 * semantic tier and re-points every value at `C`, which stays the single source of truth.
 * No hex is written down here that is not already in `C`.
 *
 * DEVIATION 2 — `chromeIntent` IS GONE, because it cannot compile on our pin.
 * It called `RGBA.defaultForeground` / `RGBA.defaultBackground`; MEASURED against the
 * installed `@opentui/core@0.1.87`, `lib/RGBA.d.ts` declares only `fromArray`,
 * `fromValues`, `fromInts` and `fromHex`, so both are `undefined` and the module threw
 * `TypeError: RGBA.defaultForeground is not a function` at import time — which took down
 * every test in `widgets.test.tsx` before one of them ran. It is the skill's own
 * "optional second tier", nothing in `color.ts` or `widgets.tsx` imports it, and claudish
 * pins 0.1.x on purpose (`build:binary` ships a `bun build --compile` binary, and the
 * skill's version matrix puts `--compile` on 0.1.x). Dropping it is the version
 * adaptation, not a downgrade — restore it if claudish ever moves to 0.4.x.
 */
import { C, registerPaletteRefresher } from "../theme.js";

/**
 * Severity / status, then chrome. A token means ONE thing across the whole app:
 * red is error everywhere, or glanceability dies.
 *
 * Several pairs deliberately share a hex because `C` has one value where the skill's
 * palette had two — `fatal`/`error` are both `C.red`, `debug`/`idle` are both
 * `C.fgMuted`, `trace`/`subtle`/`dead` are all `C.dim`. They keep separate names for the
 * same reason the skill kept `dead` and `subtle` apart: they mean different things and
 * may diverge.
 *
 * `bgPanel` IS `C.bgAlt` (#111111) AND NOT `C.bg` (#000000), which looks like a rounding
 * of the true-black aesthetic and is not. A panel background equal to the terminal void
 * is not a background: nothing distinguishes a row the panel painted from a row it never
 * reached. `widgets.test.tsx`'s `painted()` helper says so in its own comment —
 * "unpainted terminal comes back 0,0,0" — and with a black `bgPanel` it counted all 12
 * rows of a 3-row panel, failing three Panel tests whose LAYOUT an independent probe
 * showed to be correct. #111111 also matches what several existing claudish panels
 * already pass (`C.bgAlt` appears beside `C.bg` throughout `tui/components/`), and gives
 * the btop lift the skill's rule 6 asks for: dim chrome, quiet frame, saturated signal.
 */
export const tokens: Record<
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "success"
  | "running"
  | "idle"
  | "dead"
  | "border"
  | "subtle"
  | "text"
  | "accent"
  | "bgPanel"
  | "ink",
  string
> = {
  fatal: C.red, //          catastrophic
  error: C.red, //          recoverable error
  warn: C.orange, //        warning
  info: C.cyan, //          normal / informational
  debug: C.fgMuted, //      verbose
  trace: C.dim, //          dimmest
  success: C.green, //      ok / passed
  running: C.blue, //       active / healthy
  idle: C.fgMuted, //       waiting
  dead: C.dim, //           offline
  border: C.border, //      panel borders — recede
  subtle: C.dim, //         labels, units — recede
  text: C.fg, //            body text
  accent: C.focusBorder, // focus / titles
  bgPanel: C.bgAlt, //      panel background — see note below
  ink: C.black, //          text on bright badges
};

// `C` is mutable (dual light/dark palette, reassigned when the terminal theme
// is detected), but this object SNAPSHOTS its values — so it re-snapshots via
// the theme's refresher hook, which runs after `C` has been reassigned. The
// ramps below capture token values the same way and refresh in the same pass.
// REGISTERED AT THE BOTTOM of this file: registration invokes the callback
// immediately, and `ramps` must exist by then.
function refreshTokens(): void {
  tokens.fatal = C.red;
  tokens.error = C.red;
  tokens.warn = C.orange;
  tokens.info = C.cyan;
  tokens.debug = C.fgMuted;
  tokens.trace = C.dim;
  tokens.success = C.green;
  tokens.running = C.blue;
  tokens.idle = C.fgMuted;
  tokens.dead = C.dim;
  tokens.border = C.border;
  tokens.subtle = C.dim;
  tokens.text = C.fg;
  tokens.accent = C.focusBorder;
  tokens.bgPanel = C.bgAlt;
  tokens.ink = C.black;
  refreshRamps();
}

/**
 * A gradient's STOPS — AT LEAST ONE, and that bound is load-bearing rather than
 * pedantic. `blendStops` answers `[]` for an empty stop list, which is right for it and
 * fatal downstream: `Meter` painted one cell per ramp entry, so `ramp={[]}` type-checked
 * and rendered a ZERO-WIDTH meter — 40 columns asked for, none painted, nothing thrown.
 * A non-empty tuple makes that call a COMPILE error. A computed `string[]` no longer
 * fits: annotate it `Ramp` or `as const` it, which is the right pressure — a ramp is a
 * designed object, not an array that happens to hold colours. */
export type Ramp = readonly [string, ...string[]];

/**
 * Gradient STOPS, not ramps. Feed them to `blendStops(cells, ...stops)` so the
 * ramp is computed at the meter's real width — a 3-entry array is 3 stops, never
 * 3 buckets. Colour encodes POSITION along the fill here, so it must be smooth.
 *
 * The explicit midtone is the point (`color.ts` documents why): a two-stop green→red
 * blend desaturates to a muddy olive through the middle, so every ramp names the colour
 * it should pass through. `C`'s neon stops are far more saturated than the skill's
 * defaults, so the measured midpoint floor goes UP, not down.
 */
export const ramps: {
  load: Ramp;
  temperature: Ramp;
  network: Ramp;
  savings: Ramp;
  volume: Ramp;
} = {
  load: [tokens.success, C.yellow, tokens.error],
  temperature: [tokens.running, tokens.success, C.orange, tokens.error],
  network: [tokens.success, C.yellow, tokens.error],
  /**
   * `load` REVERSED, and the reversal is the whole point rather than a variation.
   *
   * A meter colours cells by POSITION along the fill, so the ramp encodes what a FULL
   * bar means. `load` ends red because a full CPU bar is bad. Savings run the other
   * way — a full bar is the best possible outcome — so reusing `load` would paint the
   * happiest session in alarm red and break rule 1 (a colour means one thing) by making
   * red mean "bad" on one row and "excellent" on the next.
   */
  savings: [tokens.error, C.yellow, tokens.success],
  /**
   * ONE HUE, dark to bright — for a magnitude that is neither good nor bad.
   *
   * The other four ramps all end in red or green because they encode HEALTH, and rule 1
   * says a colour means one thing app-wide. A quantity with no valence — a file's size, a
   * message count — painted with `load` or `temperature` therefore lies twice over: the
   * biggest one glows alarm-red, and red stops meaning "error" everywhere else. Staying
   * inside the blue family keeps the length carrying the comparison and the brightness
   * carrying the magnitude, with no health claim attached to either.
   */
  volume: [C.border, C.blue, C.cyan],
};

/** Rebuild every ramp from the CURRENT token/`C` values. Whole-tuple
 *  replacement (never in-place mutation) because `Ramp` is a readonly tuple. */
function refreshRamps(): void {
  ramps.load = [tokens.success, C.yellow, tokens.error];
  ramps.temperature = [tokens.running, tokens.success, C.orange, tokens.error];
  ramps.network = [tokens.success, C.yellow, tokens.error];
  ramps.savings = [tokens.error, C.yellow, tokens.success];
  ramps.volume = [C.border, C.blue, C.cyan];
}

/** HTTP method colours (the `posting` look). Use as badge backgrounds. */
export const methods: Record<string, string> = {
  GET: "#61AFFE",
  POST: "#49CC90",
  PUT: "#FCA130",
  PATCH: "#50E3C2",
  DELETE: "#F8615C",
  OPTIONS: "#9013FE",
};

// Keep the snapshot palette in sync with the mutable `C` — see the comment on
// `refreshTokens`. Runs once immediately (harmless: it re-writes the values the
// initializers above already hold) and again on every theme-mode change.
registerPaletteRefresher(refreshTokens);
