/** @jsxImportSource @opentui/react */
/**
 * Shimmer — the repo's indeterminate-progress idiom, promoted to a component.
 *
 * A travelling `▓▒░▒` bar, lifted from `probe/probe-tui-app.tsx:179` + `:538-543`
 * (the `ANIM_FRAMES[(animFrame + i) % 4]` loop). The PHASE OFFSET is the whole
 * point: without it every cell shows the same glyph and the bar BLINKS; with it
 * the pattern travels, which is what reads as "work is happening" rather than
 * "the screen is flickering". Drive it from `hooks/useAnimationFrame.ts`.
 *
 * USE THIS ONLY WHEN THERE IS NOTHING TO MEASURE. A shimmer makes exactly one
 * claim — time is passing — and that claim is always true. When work is
 * countable (`done/total`) use a determinate `Meter`/`MeterSpan` instead; when a
 * DEADLINE is known but the work is not, that is an elapsed-vs-deadline
 * indicator and not progress, so its label has to say so. Rendering an invented
 * denominator as a bar is the dishonest feedback this component exists to avoid.
 *
 * TWO FORMS, for the same reason `viz/widgets.tsx` ships `Meter` and `MeterSpan`:
 * a `<text>` cannot nest inside a `<text>`, so the standalone form cannot share a
 * row with a label. `Shimmer` is a row of its own; `ShimmerSpan` goes INSIDE
 * someone else's `<text>`. Putting a `<span>` outside a `<text>` renders an error
 * page instead of the UI while the process stays alive and exits 0 — `tsc`,
 * `bun test` and `check-surface` all stay green and only a screenshot catches it,
 * so the two names are kept apart on purpose. `shimmerGlyphs` is extracted so the
 * two forms cannot drift, exactly as `sparkGlyphs` is for `Sparkline`.
 */

import type { ColorInput } from "@opentui/core";
import type { ReactNode } from "react";
import { tokens } from "../viz/tokens.js";

/**
 * ▓ ▒ ░ ▒ — four glyphs, not three. The repeated `▒` is what makes the cycle
 * read as a wave passing rather than as a saw-tooth jumping back to full at
 * every fourth cell.
 */
const ANIM_FRAMES = ["▓", "▒", "░", "▒"] as const;

/**
 * The bar's glyph run at `frame`, `width` cells wide — the pure half, shared by
 * both forms above.
 *
 * `null` (never `""`) for a non-positive or non-finite width, so a caller renders
 * NOTHING rather than an empty `<text>`: an empty text node is still a flex item
 * and still eats a row, which is the convention `viz/widgets.tsx` keeps for every
 * widget with empty input.
 *
 * A negative or fractional `frame` is floored and re-normalised into range rather
 * than trusted: `(-1) % 4` is `-1` in JavaScript, and `ANIM_FRAMES[-1]` is
 * `undefined`, which `join`/`+=` would swallow — one cell silently gone and every
 * cell right of it shifted.
 */
export function shimmerGlyphs(frame: number, width: number): string | null {
  const cells = Math.floor(width);
  if (!Number.isFinite(cells) || cells <= 0) return null;
  const floored = Math.floor(frame);
  const base = Number.isFinite(floored) ? floored : 0;
  const n = ANIM_FRAMES.length;
  let out = "";
  for (let i = 0; i < cells; i++) {
    out += ANIM_FRAMES[(((base + i) % n) + n) % n];
  }
  return out;
}

/**
 * The standalone form — one `<text>`, a row of its own.
 *
 * `flexShrink={0}` for the reason `viz/widgets.tsx` gives on every widget: the
 * width is a cell count the caller computed, so a layout that quietly shortens it
 * has broken the caller's arithmetic. Over-budget overflows and clips visibly
 * instead.
 *
 * `fg` defaults to `tokens.warn` and is read at RENDER time (a default parameter
 * is evaluated per call). In-flight is the `warn` tier app-wide — expected but
 * notable, and deliberately NOT the `error` tier. A module-level `const` here
 * would snapshot the dark palette before theme detection runs and ship a
 * dark-only bar; that bug has been found six times in this repo.
 */
export function Shimmer({
  frame,
  width,
  fg = tokens.warn,
}: {
  /** The counter from `useAnimationFrame` — one step per 100 ms. */
  frame: number;
  /** Bar width, in cells. */
  width: number;
  /** Bar colour. Defaults to the in-flight tier. */
  fg?: ColorInput;
}): ReactNode {
  const glyphs = shimmerGlyphs(frame, width);
  if (glyphs === null) return null;
  return (
    <text fg={fg} flexShrink={0}>
      {glyphs}
    </text>
  );
}

/**
 * The same bar as a `<span>`, for a MIXED-CONTENT row — a label, a counter and a
 * bar in ONE `<text>`. The alternative, a flex row of `<text>` siblings, is the
 * arrangement Yoga silently shrinks: it claws columns back from the LAST child,
 * which is how a branch name once rendered as `mai` with thirty free columns
 * beside it.
 *
 * No layout props: a `<span>` is not a flex item, so its row's `<text>` owns the
 * layout for both.
 */
export function ShimmerSpan({
  frame,
  width,
  fg = tokens.warn,
}: {
  frame: number;
  width: number;
  fg?: ColorInput;
}): ReactNode {
  const glyphs = shimmerGlyphs(frame, width);
  if (glyphs === null) return null;
  return <span fg={fg}>{glyphs}</span>;
}
