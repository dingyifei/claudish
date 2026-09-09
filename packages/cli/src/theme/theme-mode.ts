/**
 * theme-mode.ts — the ONE place claudish knows whether the terminal is light or dark.
 *
 * Dependency-free on purpose (node builtins only): this module is imported by plain
 * CLI command files, the raw-ANSI printers AND the OpenTUI palettes, so it must never
 * pull @opentui/core into a code path that today runs without it.
 *
 * Detection sources, in precedence order:
 *
 *   1. `CLAUDISH_THEME=light|dark` — explicit user override, and the deterministic
 *      lever tests and screenshot harnesses use. Always wins.
 *   2. An OSC 11 query — ask the terminal its background color over the tty and
 *      classify by WCAG relative luminance. A MEASUREMENT, so it also yields the
 *      background COLOUR itself (see `getTerminalBackgroundHex`). Bounded by a
 *      timeout: a terminal that never answers must not stall startup.
 *   3. `COLORFGBG` — set by some terminals (iTerm2, rxvt). Free and synchronous,
 *      but only a HINT: it is written once and goes stale, and tmux inherits a
 *      stale value across a theme change. Measured on a real cream terminal it
 *      reported `15;0` ("dark") while OSC 11 returned `#f9f6da` ("light"). It is
 *      therefore the fallback, not the primary — used when nobody answers OSC,
 *      and by the sync path, which cannot await.
 *
 * `null` (unknown) is a real state, not an error: every consumer treats it as
 * "behave exactly as claudish behaved before light-theme support" — the dark
 * palette for the TUI, the classic 16-color escapes for CLI output. A wrong guess
 * would paint dark-on-dark or light-on-light; the status quo merely looks like
 * yesterday's claudish.
 *
 * The OpenTUI surfaces do NOT use the OSC path here — the renderer runs its own
 * OSC handshake (`renderer.waitForThemeMode`) and feeds the result into
 * `setThemeMode`, so the whole process shares one answer either way.
 */

export type TerminalThemeMode = "dark" | "light";

let detected: TerminalThemeMode | null = null;

/** Listeners run synchronously on every mode change (palette refreshers). */
const listeners: Array<(mode: TerminalThemeMode | null) => void> = [];

export function getThemeMode(): TerminalThemeMode | null {
  return detected;
}

export function setThemeMode(mode: TerminalThemeMode | null): void {
  detected = mode;
  for (const cb of listeners) cb(mode);
}

/**
 * Register a palette refresher. It is invoked immediately with the CURRENT mode
 * (so a module loaded after detection still syncs) and again on every change.
 */
export function onThemeModeChange(cb: (mode: TerminalThemeMode | null) => void): void {
  listeners.push(cb);
  cb(detected);
}

/**
 * Test seam — restore the pre-detection state between cases.
 *
 * Deliberately does NOT clear the listener registry: listeners are one-time
 * MODULE-level registrations (tui/theme.ts, viz/tokens.ts) and Bun runs sibling
 * test files in one process, so dropping them here would silently freeze the
 * palette for every test file that runs after this one. Resetting means
 * "publish null again", which resolves to the dark palette — the same state a
 * fresh process starts in.
 */
export function resetThemeModeForTests(): void {
  setThemeMode(null);
  background = null;
}

// ---------------------------------------------------------------------------
// Source 1: explicit override
// ---------------------------------------------------------------------------

export function themeModeOverride(env: NodeJS.ProcessEnv = process.env): TerminalThemeMode | null {
  const raw = env.CLAUDISH_THEME?.trim().toLowerCase();
  if (raw === "light" || raw === "dark") return raw;
  return null;
}

// ---------------------------------------------------------------------------
// Source 2: COLORFGBG ("fg;bg" or "fg;default;bg" — bg is an ANSI slot number)
// ---------------------------------------------------------------------------

export function themeModeFromColorFgBg(
  env: NodeJS.ProcessEnv = process.env
): TerminalThemeMode | null {
  const raw = env.COLORFGBG;
  if (!raw) return null;
  const last = raw.split(";").pop()?.trim();
  if (!last || !/^\d+$/.test(last)) return null;
  const bg = Number.parseInt(last, 10);
  // Slots 7 and 15 are the light grays / white; 0-6 and 8 are dark.
  if (bg === 7 || bg === 15) return "light";
  if (bg <= 8) return "dark";
  return null;
}

// ---------------------------------------------------------------------------
// Source 3: OSC 11 background query
// ---------------------------------------------------------------------------

/** WCAG 2.1 relative luminance of an sRGB triplet scaled 0..1. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Keep the light/dark boundary at the perceptual midpoint of the encoded sRGB
// range. Its WCAG-linearized luminance is lower than 0.5 because sRGB is gamma
// encoded, so compare like with like rather than applying 0.5 after linearizing.
const MID_SRGB_LUMINANCE = relativeLuminance(0.5, 0.5, 0.5);

/**
 * Parse an OSC 11 reply — `\x1b]11;rgb:RRRR/GGGG/BBBB\x07` (or ST-terminated;
 * channels may be 1-4 hex digits) — into a theme mode by luminance.
 * Exported for tests.
 */
export function classifyOscBackground(reply: string): TerminalThemeMode | null {
  const m = reply.match(/\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/);
  if (!m) return null;
  const channel = (hex: string): number => {
    // Scale by the field's own width: "ff" -> 255/255, "ffff" -> 65535/65535.
    const max = 16 ** hex.length - 1;
    return Number.parseInt(hex, 16) / max;
  };
  const lum = relativeLuminance(channel(m[1]!), channel(m[2]!), channel(m[3]!));
  return lum >= MID_SRGB_LUMINANCE ? "light" : "dark";
}

/**
 * The terminal's ACTUAL background as `#rrggbb`, from the same OSC 11 reply.
 * Exported for tests.
 *
 * The classifier above reduces this reply to one bit and discards the colour,
 * which is why the TUI painted `#ffffff` over a cream terminal and `#000000`
 * over a soft-black one: correct light/dark, visibly wrong shade. The full-screen
 * page cannot simply be transparent — the 1Password add-wizard is an absolute
 * overlay that relies on an opaque `C.bg` to occlude the list beneath it — so
 * matching the terminal exactly is how the page becomes invisible while STAYING
 * opaque.
 */
export function parseOscBackgroundHex(reply: string): string | null {
  const m = reply.match(/\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/);
  if (!m) return null;
  const byte = (hex: string): string => {
    const max = 16 ** hex.length - 1;
    const v = Math.round((Number.parseInt(hex, 16) / max) * 255);
    return v.toString(16).padStart(2, "0");
  };
  return `#${byte(m[1]!)}${byte(m[2]!)}${byte(m[3]!)}`;
}

/**
 * Terminal background colour, once an OSC 11 query has answered. `null` means
 * unknown — under a pipe, a `dumb` terminal, or a terminal that never replies —
 * and every consumer must fall back to its palette's own page colour rather
 * than guessing.
 */
let background: { hex: string; mode: TerminalThemeMode } | null = null;

export function getTerminalBackgroundHex(): string | null {
  return background?.hex ?? null;
}

/**
 * The measured background AND the light/dark mode its own luminance implies.
 *
 * The pair travels together so a consumer can refuse to paint the colour under
 * a palette chosen for the OTHER mode. That is a real risk rather than a
 * theoretical one: the published mode can come from somewhere else entirely —
 * OpenTUI's own handshake, `COLORFGBG`, or an explicit `CLAUDISH_THEME` — and
 * cream under dark-mode foregrounds is unreadable, which is strictly worse than
 * the hardcoded page colour this replaces.
 */
export function getTerminalBackground(): { hex: string; mode: TerminalThemeMode } | null {
  return background;
}

/** Test seam — also cleared by {@link resetThemeModeForTests}. */
export function setTerminalBackgroundHex(hex: string | null): void {
  if (!hex) {
    background = null;
    return;
  }
  const mode = classifyOscBackground(
    `]11;rgb:${hex.slice(1, 3)}/${hex.slice(3, 5)}/${hex.slice(5, 7)}`
  );
  background = mode ? { hex, mode } : null;
}

/**
 * Ask the terminal for its background color (OSC 11) and classify it.
 *
 * Only runs when stdin AND stdout are TTYs — the query goes out on stdout and the
 * reply arrives on stdin, and under a pipe (claudish as a proxy inside Claude
 * Code) neither holds, so this can never inject escape sequences into a
 * conversation with another program's TUI.
 */
export async function queryTerminalThemeMode(timeoutMs = 150): Promise<TerminalThemeMode | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") return null;
  if (process.env.TERM === "dumb") return null;

  return await new Promise<TerminalThemeMode | null>((resolve) => {
    let buffer = "";
    let settled = false;
    const wasRaw = stdin.isRaw === true;

    const finish = (mode: TerminalThemeMode | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      try {
        if (!wasRaw) stdin.setRawMode(false);
        stdin.pause();
      } catch {
        // Terminal went away mid-query; the mode result still stands.
      }
      resolve(mode);
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("latin1");
      // Reply ends with BEL or ST (ESC \).
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the OSC 11 reply terminator IS a control char (BEL or ESC \)
      if (/\]11;[^\x07\x1b]*(\x07|\x1b\\)/.test(buffer)) {
        // Keep the COLOUR as well as the light/dark bit — the TUI paints its
        // page with it so the page matches the terminal exactly. Both are
        // derived from THIS reply, so they cannot disagree.
        const mode = classifyOscBackground(buffer);
        const hex = parseOscBackgroundHex(buffer);
        background = hex && mode ? { hex, mode } : null;
        finish(mode);
      }
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      if (!wasRaw) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.write("\x1b]11;?\x07");
    } catch {
      finish(null);
    }
  });
}

// ---------------------------------------------------------------------------
// The composed detector
// ---------------------------------------------------------------------------

/**
 * Detect and publish the terminal theme mode. Cheap sources first; the OSC
 * round-trip only runs when they were silent and both ends of the terminal are
 * ours. Call once, early, from interactive entry points. Safe to call again —
 * a second call just re-publishes.
 */
export async function detectAndSetThemeMode(): Promise<TerminalThemeMode | null> {
  const override = themeModeOverride();
  if (override) {
    // An explicit CLAUDISH_THEME is a choice of PALETTE, so the terminal's own
    // colour is not adopted — the user may well be forcing dark on a light
    // terminal, and painting their background under our dark foregrounds would
    // be unreadable. Skipping the OSC round-trip entirely is also free here.
    setTerminalBackgroundHex(null);
    setThemeMode(override);
    return override;
  }

  // OSC 11 IS AUTHORITATIVE, ABOVE COLORFGBG. It used to be the last resort,
  // short-circuited whenever COLORFGBG answered. Two measurements on a real
  // terminal overturned that ordering:
  //
  //   COLORFGBG="15;0"                     → "dark"   (bg slot 0 = black)
  //   OSC 11 reply, 19ms                   → "light", background #f9f6da
  //
  // The terminal is genuinely cream. COLORFGBG was simply WRONG — it is a hint
  // the emulator sets once, and tmux inherits a stale value that survives a
  // theme change. Believing it produced a dark palette on a light terminal AND
  // discarded the only accurate reading available.
  //
  // An OSC reply is a MEASUREMENT of the actual background, and it settles the
  // mode and the colour together, so the two can never contradict each other —
  // which is what made the previous "sources disagree" reconciliation
  // necessary. That reconciliation is gone with it.
  //
  // COLORFGBG remains the fallback for terminals that do not answer (and the
  // sync path, which cannot await, still has nothing else). Cost when nobody
  // answers is one bounded 150ms wait per interactive launch; the measured
  // reply here arrived in 19ms.
  const fromOsc = await queryTerminalThemeMode(150);
  if (fromOsc) {
    setThemeMode(fromOsc);
    return fromOsc;
  }

  const fromEnv = themeModeFromColorFgBg();
  setThemeMode(fromEnv);
  return fromEnv;
}

/**
 * Synchronous variant for paths that cannot await (no OSC round-trip). Publishes
 * only when a cheap source answered; otherwise leaves the current state alone.
 */
export function detectAndSetThemeModeSync(): TerminalThemeMode | null {
  const mode = themeModeOverride() ?? themeModeFromColorFgBg();
  if (mode) setThemeMode(mode);
  return mode ?? detected;
}
