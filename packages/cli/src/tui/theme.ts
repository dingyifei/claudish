/** @jsxImportSource @opentui/react */
import { createTextAttributes } from "@opentui/core";
import { getTerminalBackground, onThemeModeChange } from "../theme/theme-mode.js";

/**
 * The TUI palette — TWO palettes, selected by the detected terminal theme.
 *
 * DARK is the original btop-inspired set (true black base, vivid neon colors)
 * and stays byte-identical to what claudish always shipped: an unknown theme
 * (`null` from detection) also resolves to DARK, so a terminal that never
 * answers the OSC query gets yesterday's claudish, not a guess.
 *
 * LIGHT is a deep, saturated set — every text accent clears 4.5:1 against a
 * white page (verified by `theme-contrast.test.ts`), so it stays vivid without
 * washing out. Selection is a light-blue WASH (not a dark fill), which is why
 * emphasized text uses `C.strong` (theme-following) rather than `C.white`:
 * white ink on a wash would vanish.
 *
 * Token semantics that make both palettes work:
 *  - `C.ink`    — ink on fills WE paint that stay mid/dark in both themes
 *                 (pills, latency chips, active tab). Always white.
 *  - `C.strong` — emphasized text on the PAGE or on wash fills. White on dark,
 *                 near-black on light. Never use `C.white` for page text.
 *
 * `C` is intentionally MUTABLE: `theme-mode.ts` publishes the detected mode and
 * the listener below reassigns every field in place, so the hundreds of `C.*`
 * reads across the components pick up the right palette at render time with no
 * plumbing. Derived escape tables (STAGE_BG_ANSI) are refreshed by the same
 * listener; register additional derived palettes via `registerPaletteRefresher`.
 */

export interface TuiPalette {
  bg: string;
  bgAlt: string;
  bgHighlight: string;
  bgError: string;
  fg: string;
  fgMuted: string;
  dim: string;
  border: string;
  focusBorder: string;
  green: string;
  brightGreen: string;
  red: string;
  yellow: string;
  cyan: string;
  blue: string;
  magenta: string;
  orange: string;
  white: string;
  black: string;
  ink: string;
  strong: string;
  tabActiveBg: string;
  tabInactiveBg: string;
  tabActiveFg: string;
  tabInactiveFg: string;
  pillKeyBg: string;
  pillOauthBg: string;
  chipKeyBg: string;
  chipLabelBg: string;
}

const DARK: TuiPalette = {
  bg: "#000000",
  bgAlt: "#111111",
  bgHighlight: "#1e3a5f",
  bgError: "#3a0a14", // faint red-tinted band for failed test rows

  fg: "#ffffff",
  fgMuted: "#a0a0a0",
  dim: "#555555",

  border: "#333333",
  focusBorder: "#57a5ff",

  green: "#39ff14",
  brightGreen: "#55ff55",
  red: "#ff003c",
  yellow: "#fce94f",
  cyan: "#00ffff",
  blue: "#0088ff",
  magenta: "#ff00ff",
  orange: "#ff8800",
  white: "#ffffff",
  black: "#000000",

  ink: "#ffffff", // ink on our own mid/dark fills — same in both themes
  strong: "#ffffff", // emphasized page text — follows the theme

  // Unified tab theme based on blue
  tabActiveBg: "#0088ff",
  tabInactiveBg: "#001a33",
  tabActiveFg: "#ffffff",
  tabInactiveFg: "#0088ff",

  // Muted pill backgrounds for AUTH column tags. The standard `green` / `cyan`
  // are neon-bright and cause eye strain when used as a solid fill. These
  // are lower-saturation forest/teal versions, contrast-tuned for white text.
  pillKeyBg: "#2d6e3e", // forest green; white text reads cleanly
  pillOauthBg: "#1f6d75", // muted teal; white text reads cleanly

  // Monochrome two-tone footer chip. The key sits on the LIGHTER segment and
  // the label on the DARKER segment; the two abut into one connected pill.
  // Neutral gray (no per-hotkey color) — emphasis comes from text brightness
  // (bright key vs. muted label), not hue.
  chipKeyBg: "#3a3a3a", // lighter gray — key segment
  chipLabelBg: "#222222", // darker gray — label segment
};

const LIGHT: TuiPalette = {
  // Opaque white page, mirroring DARK's opaque true black: the 1Password modal
  // is an absolute overlay that relies on `C.bg` to COVER the list beneath it,
  // so the page color cannot be transparent.
  bg: "#ffffff",
  bgAlt: "#f3f4f6", // quiet gray band (header/footer/detail)
  bgHighlight: "#bfdbfe", // light-blue selection WASH — dark text rides on top
  bgError: "#fee2e2", // faint red wash for failed test rows

  fg: "#1f2937",
  fgMuted: "#4b5563",
  dim: "#6b7280",

  border: "#d1d5db",
  focusBorder: "#2563eb",

  // Deep, saturated accents — vivid on white, all >= 4.5:1 on #ffffff.
  green: "#15803d",
  brightGreen: "#166534",
  red: "#dc2626",
  yellow: "#a16207",
  cyan: "#0e7490",
  blue: "#1d4ed8",
  magenta: "#9333ea",
  orange: "#c2410c",
  white: "#ffffff",
  black: "#000000",

  ink: "#ffffff",
  strong: "#111827",

  tabActiveBg: "#2563eb", // vivid blue pill, white ink
  tabInactiveBg: "#e5e7eb",
  tabActiveFg: "#ffffff",
  tabInactiveFg: "#374151",

  // The forest/teal pills are mid-lightness fills with white ink — they clear
  // contrast on BOTH pages, so they are shared verbatim with DARK.
  pillKeyBg: "#2d6e3e",
  pillOauthBg: "#1f6d75",

  chipKeyBg: "#d1d5db", // key segment — theme text (`C.fg`) rides on top
  chipLabelBg: "#e5e7eb", // label segment
};

export const C: TuiPalette = { ...DARK };

const bold = createTextAttributes({ bold: true });

export const A = {
  bold,
  boldIf: (enabled: boolean): number | undefined => (enabled ? bold : undefined),
} as const;

// ---------------------------------------------------------------------------
// Latency → background color buckets
// ---------------------------------------------------------------------------
//
// Used wherever a probe/test latency is shown (--probe TUI chain rows + final
// static table). The `ms` token gets a SOLID background so a fast response and
// a slow-but-successful response read differently at a glance — status color
// (green=live / red=error) alone can't carry "this worked but took 14s".
//
// DISCRETE BUCKETS, not a smooth gradient: a continuous green→red ramp made
// adjacent latencies (976ms vs 2519ms vs 4713ms) look nearly identical. Buckets
// pick visibly DIFFERENT colors per band. Each fill is a mid-lightness color
// chosen to stay readable under white text (neon foregrounds like C.green are
// too bright as a fill — same reasoning as pillKeyBg above).
//
// Thresholds (good → bad):
//   < 500ms        bright green
//   500ms – 1s     green
//   1s   – 3s      yellow
//   3s   – 6s      orange
//   > 6s           red

interface LatencyBucket {
  /** Inclusive upper bound in ms; Infinity for the last bucket. */
  maxMs: number;
  /** `#rrggbb` for OpenTUI `<span bg>`. */
  hex: string;
}

const LATENCY_BUCKETS_DARK: LatencyBucket[] = [
  { maxMs: 500, hex: "#1f8f3b" }, // bright green
  { maxMs: 1000, hex: "#2d6e3e" }, // green (matches pillKeyBg family)
  { maxMs: 3000, hex: "#8a7d1e" }, // yellow/olive
  { maxMs: 6000, hex: "#b5651d" }, // orange
  { maxMs: Number.POSITIVE_INFINITY, hex: "#9e2b2b" }, // red
];

// Slightly deeper equivalents keep white latency ink at >= 4.5:1 on light
// terminals without changing the shipped dark-theme bucket colors above.
const LATENCY_BUCKETS_LIGHT: LatencyBucket[] = [
  { maxMs: 500, hex: "#1d8738" }, // bright green
  { maxMs: 1000, hex: "#2d6e3e" }, // green (already clears 4.5:1)
  { maxMs: 3000, hex: "#83771c" }, // yellow/olive
  { maxMs: 6000, hex: "#b0621c" }, // orange
  { maxMs: Number.POSITIVE_INFINITY, hex: "#9e2b2b" }, // red
];

let activeLatencyBuckets = LATENCY_BUCKETS_DARK;

function latencyBucket(ms: number): LatencyBucket {
  const v = Math.max(0, ms);
  for (const b of activeLatencyBuckets) {
    if (v < b.maxMs) return b;
  }
  return activeLatencyBuckets[activeLatencyBuckets.length - 1]!;
}

/**
 * Human-readable latency: under 1s → "399ms"; 1s and over → "14.34s" (2 dp).
 * No padding — callers pad to align.
 */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Background color for a latency value as a `#rrggbb` hex string (discrete
 * bucket), suitable for an OpenTUI `<span bg={...}>`.
 */
export function latencyBg(ms: number): string {
  return latencyBucket(ms).hex;
}

/**
 * Background color for a latency value as a raw ANSI truecolor SGR escape
 * (`\x1b[48;2;R;G;Bm`), for the static results printer which emits raw ANSI
 * (not OpenTUI). Pair with `LATENCY_FG_ANSI` + `ANSI_RESET`.
 */
export function latencyBgAnsi(ms: number): string {
  const hex = latencyBucket(ms).hex;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Foreground color to pair with `latencyBg`. Kept light/white across all
 * buckets so the number is always legible; the BACKGROUND carries the
 * good→bad signal, not the text color.
 */
export const latencyFg = "#ffffff";

/** ANSI counterparts for the raw-ANSI printer path. */
export const LATENCY_FG_ANSI = "\x1b[38;2;255;255;255m";
export const ANSI_RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Probe timeline stage colors (network → server → streaming)
// ---------------------------------------------------------------------------
//
// The --probe TUI breaks each successful link into 3 sequential stages and
// renders them as a stacked, shared-scale bar. Segment FILLS use DESATURATED
// mid-lightness backgrounds (not the neon C.cyan/C.blue/C.yellow — those are
// too harsh as solid fills; same rule as pillKeyBg/latencyBg). The breakdown
// NUMBERS use the bright foreground versions so number↔segment is unmistakable.
//
// cool → cool → warm: network (waiting on the wire) → server (model thinking)
// → streaming (the stage actually producing tokens, so it gets the warm hue).
// All three avoid the reserved status colors (green=live, red=fail) and leave
// cyan free for "probing".

// VIVID, saturated fills. These are bg-on-SPACES (no text sits on them), so the
// "desaturate for text readability" rule that governs pillKeyBg/latencyBg does
// NOT apply here — high-contrast hues are exactly what makes the segments pop
// and read distinctly next to each other on the terminal background.
//
// Per-theme: the neon set pops on black but washes out on white (#ffcc00 vs a
// white page is 1.4:1 — nearly invisible), so LIGHT swaps in deeper fills that
// still read as cyan/blue/gold next to each other.
const STAGE_BG_DARK = {
  network: "#00b3c4", // bright cyan
  server: "#2563ff", // bright blue
  streaming: "#ffcc00", // bright gold/yellow
} as const;

const STAGE_BG_LIGHT = {
  network: "#0891b2", // deep cyan
  server: "#2563eb", // deep blue
  streaming: "#d97706", // deep amber
} as const;

export const STAGE_BG: { network: string; server: string; streaming: string } = {
  ...STAGE_BG_DARK,
};

/** Stage label/number colors. MUTABLE — a module-load `C.*` read would freeze
 *  the dark neons before detection completes (found live: breakdown numbers
 *  rendered neon cyan/pale yellow on a white page); refreshed with the mode. */
export const STAGE_FG: { network: string; server: string; streaming: string } = {
  network: C.cyan,
  server: C.blue,
  streaming: C.yellow,
};

function hexToAnsiBg(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Truecolor FOREGROUND ANSI escape for a `#rrggbb` hex. The raw-ANSI printer
 * uses this for stage labels (STAGE_FG.*) and the tok/s bar/value
 * (throughputFg(ratio)) — so it never hand-rolls colors that drift from the
 * shared palette. Pair with `ANSI_RESET`.
 */
export function hexToAnsiFg(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** ANSI background escapes for the static printer's stage segments.
 *  MUTABLE — refreshed alongside `STAGE_BG` when the theme mode changes. */
export const STAGE_BG_ANSI: { network: string; server: string; streaming: string } = {
  network: hexToAnsiBg(STAGE_BG.network),
  server: hexToAnsiBg(STAGE_BG.server),
  streaming: hexToAnsiBg(STAGE_BG.streaming),
};

export type ProbeStageKey = keyof typeof STAGE_BG;

// ---------------------------------------------------------------------------
// Theme application — the reactive core
// ---------------------------------------------------------------------------

/** Derived palettes (viz tokens, ramps) register here to be recomputed AFTER
 *  `C` has been reassigned. Invoked immediately on registration so a module
 *  loaded after detection still syncs. */
const paletteRefreshers: Array<() => void> = [];

export function registerPaletteRefresher(fn: () => void): void {
  paletteRefreshers.push(fn);
  fn();
}

/**
 * The NEUTRAL SURFACES — tokens whose only job is to sit a measured shade away
 * from the page. When the page moves, these must move with it or the seam the
 * page adoption removed simply reappears one box further in.
 *
 * Deliberately excluded: `bgHighlight` (blue selection wash) and `bgError` (red
 * failure wash) carry their meaning in their HUE, and `tabActiveBg` / the pill
 * fills are accents. Re-tinting those would erase the signal they exist to send.
 */
const SURFACE_TOKENS = ["bgAlt", "border", "tabInactiveBg", "chipKeyBg", "chipLabelBg"] as const;

/** `#rrggbb` → `[r, g, b]`, or null for anything that isn't one. */
function hexChannels(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** `[r, g, b]` → `#rrggbb`, clamping each channel into range. */
function channelsToHex(c: [number, number, number]): string {
  const hex = c
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
  return `#${hex}`;
}

/**
 * Re-express every neutral surface in the PAGE's colour, by transplanting the
 * per-channel offset it has from the palette's own page colour.
 *
 * OFFSETS, not ratios. DARK's page is `#000000`, and a ratio against zero is
 * undefined — every derived surface would collapse back to black. The offset
 * form (`#111111 − #000000 = +17,+17,+17`) works unchanged in both palettes.
 *
 * The offset IS the tuning: the palette author chose how far the band sits from
 * the page, and that distance is preserved channel-for-channel. Only the hue it
 * is expressed in changes. On a cream terminal `bgAlt` stops being a grey slab
 * (`#f3f4f6`) and becomes a deeper cream, which is what "quiet band" meant all
 * along — the grey was only ever standing in for "slightly darker than white".
 *
 * Byte-identical when the page equals the palette's own page: the offset then
 * re-creates the original token exactly, so a plain white or plain black
 * terminal renders as it did before this existed.
 */
function retintSurfaces(palette: TuiPalette, pageHex: string): void {
  const paletteBg = hexChannels(palette.bg);
  const page = hexChannels(pageHex);
  if (!paletteBg || !page) return;
  for (const token of SURFACE_TOKENS) {
    const original = hexChannels(palette[token]);
    if (!original) continue;
    C[token] = channelsToHex([
      page[0] + (original[0] - paletteBg[0]),
      page[1] + (original[1] - paletteBg[1]),
      page[2] + (original[2] - paletteBg[2]),
    ]);
  }
}

function applyTuiTheme(mode: "light" | "dark" | null): void {
  // Unknown stays DARK — the pre-light-theme status quo, never a guess.
  const palette = mode === "light" ? LIGHT : DARK;
  activeLatencyBuckets = mode === "light" ? LATENCY_BUCKETS_LIGHT : LATENCY_BUCKETS_DARK;
  Object.assign(C, palette);
  // PAGE COLOUR = the terminal's own background, when the OSC 11 query answered.
  //
  // The palettes hardcode `#ffffff` / `#000000`, which is the right light/dark
  // CLASS but rarely the right shade: on a cream terminal the TUI painted a
  // white slab inside it, and the seam was obvious at every edge. Adopting the
  // measured colour makes the page indistinguishable from the terminal while
  // keeping `C.bg` OPAQUE — which it must stay, because the 1Password
  // add-wizard is an absolute overlay that relies on it to cover the list
  // beneath (a transparent page would show the list through the modal).
  //
  // The NEUTRAL SURFACES move with it (`retintSurfaces`). Adopting the page
  // alone was not enough: the header, footer and detail panels are painted in
  // `bgAlt`, a grey that only ever meant "a shade off white", so on a cream
  // terminal the seam did not disappear — it moved inward, and every panel
  // became a grey slab floating on cream. The washes that carry meaning in
  // their hue (`bgHighlight`, `bgError`) and the accent fills stay put.
  //
  // Safe by construction: the mode was classified from THIS colour's luminance,
  // so the palette's foregrounds were already chosen against it.
  // Adopted ONLY when the colour's own luminance agrees with the mode being
  // published. The mode can arrive from OpenTUI's handshake, COLORFGBG or an
  // explicit CLAUDISH_THEME — none of which know about this colour — and cream
  // under dark-mode foregrounds is unreadable, which is strictly worse than the
  // hardcoded page this replaces.
  const terminalBg = getTerminalBackground();
  if (terminalBg && terminalBg.mode === mode) {
    C.bg = terminalBg.hex;
    retintSurfaces(palette, terminalBg.hex);
  }
  Object.assign(STAGE_BG, mode === "light" ? STAGE_BG_LIGHT : STAGE_BG_DARK);
  STAGE_BG_ANSI.network = hexToAnsiBg(STAGE_BG.network);
  STAGE_BG_ANSI.server = hexToAnsiBg(STAGE_BG.server);
  STAGE_BG_ANSI.streaming = hexToAnsiBg(STAGE_BG.streaming);
  // AFTER the C reassignment, so these read the incoming palette's accents.
  STAGE_FG.network = C.cyan;
  STAGE_FG.server = C.blue;
  STAGE_FG.streaming = C.yellow;
  for (const fn of paletteRefreshers) fn();
}

// Subscribe at module load: runs once with the CURRENT mode (covering the case
// where detection completed before this module was imported) and again on every
// later `setThemeMode`.
onThemeModeChange(applyTuiTheme);

/**
 * Throughput-heat color for a tokens/sec value, on an ABSOLUTE scale (t/s),
 * NOT relative to the run's fastest generator. Relative coloring made every
 * healthy model dim-red whenever one outlier set a high max; absolute coloring
 * reflects "is this throughput actually good." The tok/s BAR stays relative-to-max
 * (that's the comparison), while the COLOR is absolute (that's the health) — the
 * dual encoding is what lets a fast model read warm even next to a faster one.
 * Reuses the muted slow-red so neon C.red stays reserved for outright failure.
 */
export function throughputFg(tokensPerSec: number): string {
  if (tokensPerSec >= 100) return C.brightGreen;
  if (tokensPerSec >= 40) return C.orange;
  return "#9e2b2b"; // muted red (same as the slow latency bucket)
}

// ---------------------------------------------------------------------------
// Shared bar cell-math (pure) — used by BOTH the live TUI (probe-tui-app.tsx)
// and the static printer (probe-results-printer.ts). Centralised here so the
// two renderers can never drift: only the rendering (OpenTUI `<span bg>` vs raw
// ANSI escapes) differs; the cell counts are computed identically.
// ---------------------------------------------------------------------------

/** Per-stage cell counts for a timeline bar; sums exactly to `barCells`. */
export interface StageCells {
  network: number;
  server: number;
  streaming: number;
}

/**
 * Total bar length in cells under a SHARED GLOBAL SCALE: the slowest link in
 * the whole run fills `barWidth`; everything else is proportionally shorter.
 * Clamped to ≥1 so a live link never vanishes.
 *
 *   barCells = clamp(round(B * totalMs / maxTotalMs), 1, B)
 */
export function timelineBarCells(totalMs: number, maxTotalMs: number, barWidth: number): number {
  if (barWidth <= 0) return 0;
  const denom = maxTotalMs > 0 ? maxTotalMs : 1;
  const raw = Math.round((barWidth * Math.max(0, totalMs)) / denom);
  return Math.min(barWidth, Math.max(1, raw));
}

/**
 * Split `barCells` across the 3 sequential stages (network=ttfbMs,
 * server=ttftMs−ttfbMs, streaming=totalMs−ttftMs) by time share using
 * LARGEST-REMAINDER rounding so the parts sum EXACTLY to `barCells`.
 *
 * GUARD: when `barCells >= 3`, every stage with a positive duration gets ≥1
 * cell (stolen from the largest-allocated stage). Below 3 the guard is dropped
 * — the colored breakdown numbers carry the detail for tiny fast bars.
 */
export function splitStageCells(
  ttfbMs: number,
  ttftMs: number,
  totalMs: number,
  barCells: number
): StageCells {
  const net = Math.max(0, ttfbMs);
  const srv = Math.max(0, ttftMs - ttfbMs);
  const str = Math.max(0, totalMs - ttftMs);
  const durations = [net, srv, str];
  const sum = net + srv + str;

  if (barCells <= 0) return { network: 0, server: 0, streaming: 0 };
  if (sum <= 0) {
    // No measurable time — put everything in the first stage so the bar still
    // renders something rather than vanishing.
    return { network: barCells, server: 0, streaming: 0 };
  }

  // Largest-remainder: floor each share, then hand leftover cells to the
  // largest fractional remainders.
  const exact = durations.map((d) => (barCells * d) / sum);
  const floors = exact.map((e) => Math.floor(e));
  let used = floors[0] + floors[1] + floors[2];
  let leftover = barCells - used;
  const remainders = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; k < leftover; k++) {
    floors[remainders[k % 3].i] += 1;
  }

  // Min-1-cell guard for non-zero stages (only when there's room: barCells>=3).
  if (barCells >= 3) {
    for (let i = 0; i < 3; i++) {
      if (durations[i] > 0 && floors[i] === 0) {
        // Steal one cell from the currently largest-allocated stage.
        let donor = 0;
        for (let j = 1; j < 3; j++) {
          if (floors[j] > floors[donor]) donor = j;
        }
        if (floors[donor] > 1) {
          floors[donor] -= 1;
          floors[i] += 1;
        }
      }
    }
  }

  used = floors[0] + floors[1] + floors[2];
  leftover = barCells - used;
  // Safety: if rounding/guard drift left a tiny surplus or deficit, settle it
  // on the largest-duration stage so the parts still sum to barCells.
  if (leftover !== 0) {
    let big = 0;
    for (let j = 1; j < 3; j++) if (durations[j] > durations[big]) big = j;
    floors[big] = Math.max(0, floors[big] + leftover);
  }

  return { network: floors[0], server: floors[1], streaming: floors[2] };
}

/**
 * Tok/s bar length under a shared scale (opposite polarity — long = good):
 *
 *   tokCells = clamp(round(T * tokensPerSec / maxTokPerSec), 0, T)
 *
 * Note: the 50ms streaming floor is applied to the SCALE denominator
 * (`maxTokPerSec`) by the caller — NOT here. This uses the raw tokensPerSec;
 * the clamp absorbs any artifact link.
 */
export function tokBarCells(tokensPerSec: number, maxTokPerSec: number, tokWidth: number): number {
  if (tokWidth <= 0) return 0;
  const denom = maxTokPerSec > 0 ? maxTokPerSec : 1;
  const raw = Math.round((tokWidth * Math.max(0, tokensPerSec)) / denom);
  return Math.min(tokWidth, Math.max(0, raw));
}
