/**
 * branding.ts — the claudish wordmark, shared by `--version` and interactive startup.
 *
 * Two renderings, chosen by the terminal that will display it:
 *  - the six-row block wordmark (60 columns wide), when the stream is a TTY
 *    at least `MIN_LOGO_WIDTH` columns across;
 *  - a single tinted line, when it is narrower, or `TERM=dumb`.
 *
 * Colors come from `cliAnsi()` resolved INSIDE each function, never at module
 * load: theme detection runs at CLI startup, after this module is imported, so
 * a module-level snapshot would always capture the pre-detection (dark) palette.
 * `NO_COLOR` empties every escape through the same helper.
 */

import { cliAnsi } from "./theme/ansi.js";

/** Narrower than this and the block wordmark wraps, so the compact line is used. */
const MIN_LOGO_WIDTH = 64;

/** Marketing line under the wordmark — same words as the README header. */
export const TAGLINE = "Claude Code. Any Model.";

/**
 * The wordmark, uncolored. Block glyphs (`█`) draw the letterform; the
 * box-drawing glyphs are its drop shadow, and `paint()` tints the two
 * differently so the shadow reads as depth rather than as more letter.
 */
const WORDMARK: readonly string[] = [
  " ██████╗██╗      █████╗ ██╗   ██╗██████╗ ██╗███████╗██╗  ██╗",
  "██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██║██╔════╝██║  ██║",
  "██║     ██║     ███████║██║   ██║██║  ██║██║███████╗███████║",
  "██║     ██║     ██╔══██║██║   ██║██║  ██║██║╚════██║██╔══██║",
  "╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝██║███████║██║  ██║",
  " ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝╚══════╝╚═╝  ╚═╝",
];

/**
 * Tint a wordmark row: solid blocks in the accent color, shadow glyphs dimmed.
 *
 * Order matters. The block pass runs first and injects escape sequences, but an
 * escape sequence contains none of the shadow glyphs, so the second pass cannot
 * match inside what the first pass wrote.
 */
function paint(line: string): string {
  const { RESET, BOLD, CYAN, BLUE, DIM } = cliAnsi();
  if (!CYAN && !BLUE) return line; // NO_COLOR — leave the art untouched
  return line
    .replace(/█+/g, (run) => `${BOLD}${CYAN}${run}${RESET}`)
    .replace(/[╗╝║═╔╚]+/g, (run) => `${DIM}${BLUE}${run}${RESET}`);
}

/** Does this stream get the block wordmark, or the compact line? */
function fitsWordmark(stream: NodeJS.WriteStream): boolean {
  if (process.env.TERM === "dumb") return false;
  const columns = stream.columns ?? 0;
  return columns >= MIN_LOGO_WIDTH;
}

/** The colored block wordmark as lines, without surrounding blank lines. */
export function wordmarkLines(): string[] {
  return WORDMARK.map((line) => `  ${paint(line)}`);
}

/** One-line fallback wordmark for narrow or dumb terminals. */
export function compactLogo(): string {
  const { RESET, BOLD, CYAN, DIM } = cliAnsi();
  return `  ${BOLD}${CYAN}claudish${RESET} ${DIM}·${RESET} ${TAGLINE}`;
}

export interface LogoOptions {
  /** Printed under the wordmark as `claudish version <version>`. */
  version?: string;
  /** Trailing blank line after the block. Default true. */
  trailingBlankLine?: boolean;
}

/**
 * Write the logo to `stream`, choosing the block wordmark or the compact line
 * by the stream's width. Callers decide WHETHER to show a logo (TTY, --quiet);
 * this function only decides which one fits.
 */
export function printLogo(stream: NodeJS.WriteStream, options: LogoOptions = {}): void {
  const { version, trailingBlankLine = true } = options;
  const { RESET, BOLD, DIM, GRAY } = cliAnsi();

  stream.write("\n");
  if (fitsWordmark(stream)) {
    for (const line of wordmarkLines()) stream.write(`${line}\n`);
    stream.write(`\n  ${GRAY}${TAGLINE}${RESET}\n`);
  } else {
    stream.write(`${compactLogo()}\n`);
  }
  if (version) {
    stream.write(`  ${DIM}claudish version${RESET} ${BOLD}${version}${RESET}\n`);
  }
  if (trailingBlankLine) stream.write("\n");
}
