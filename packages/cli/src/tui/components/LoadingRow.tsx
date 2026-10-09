/** @jsxImportSource @opentui/react */
/**
 * LoadingRow — one row that says what is loading and how much is known about it.
 *
 * ONE `<text>`, always: bar · figure · label. Sibling `<text>`s in a row are the
 * arrangement Yoga shrinks from the last child inward, so every part of the row
 * is a `<span>` inside a single text node (`viz/widgets.tsx` documents the
 * measured failure; `resume-picker.tsx:473-484` is where this repo hit it).
 *
 * THE ROW'S SHAPE IS THE HONESTY CONTRACT, and it is chosen by what the caller
 * can actually measure:
 *
 * | Caller knows | Pass | Draws |
 * |---|---|---|
 * | work done / work total | `pct` 0–100 | a determinate `MeterSpan` |
 * | nothing but that it started | `pct` omitted | a travelling `ShimmerSpan` |
 * | the value is absent, not zero | `pct: NaN` | `MeterSpan`'s dim `╌` run |
 *
 * The third row is not a curiosity: `Meter` paints a full-width TRACK for `NaN`
 * unless it is guarded, which is pixel-identical to a healthy 0% — a dead sensor
 * that looks idle. `MeterSpan` already draws `╌` instead, and passing `NaN`
 * through rather than coercing it is what keeps that distinction alive here.
 *
 * A DEADLINE IS NOT PROGRESS. `pct = 100 * elapsed / deadline` renders fine and
 * says something true only if the LABEL says which it is (`… · 2.1s / 5.0s
 * deadline`). Where no deadline is published, omit `pct` and put the elapsed
 * figure in `value` — an elapsed counter with no bar makes exactly one claim.
 *
 * `value` is right-aligned in a reserved column so a counter ticking from `9/31`
 * to `10/31` cannot shove the label sideways every frame.
 */

import type { ColorInput } from "@opentui/core";
import type { ReactNode } from "react";
import { displayWidth, padStartTo, padTo } from "../viz/text.js";
import { type Ramp, ramps, tokens } from "../viz/tokens.js";
import { MeterSpan } from "../viz/widgets.js";
import { ShimmerSpan } from "./Shimmer.js";

export interface LoadingRowProps {
  /** What is in flight, e.g. `checking credentials`. Lower case, no ellipsis. */
  label: string;
  /** The counter from `useAnimationFrame` — ignored when `pct` is given. */
  frame: number;
  /** Bar width in cells. */
  width?: number;
  /** 0–100 for a determinate meter; omit for a shimmer; `NaN` for absent data. */
  pct?: number;
  /** The figure between bar and label, e.g. `17/31` or `2.1s`. */
  value?: string;
  /** Columns reserved for `value`, so a growing counter cannot shift the label. */
  valueWidth?: number;
  /** Meter gradient. Defaults to `ramps.volume` — see below. */
  ramp?: Ramp;
  /** Shimmer colour. Defaults to the in-flight tier. */
  fg?: ColorInput;
  /**
   * Put the LABEL first, padded to this many columns, instead of last.
   *
   * The default (bar · figure · label) reads well in a horizontal strip where the
   * bars line up and the labels trail off. It reads badly as a stacked list of
   * named operations, which is what a loading DIALOG is: there the reader is
   * scanning "what is claudish doing", so the names have to form the left column
   * and the bars the second. Both orders keep one `<text>` per row, and the
   * padding is what makes the bars align.
   */
  labelWidth?: number;
}

/**
 * `ramps.volume` IS THE DEFAULT, NOT `ramps.load`.
 *
 * A meter colours cells by POSITION along the fill, so the ramp encodes what a
 * FULL bar means. `load` ends red because a full CPU bar is bad; a full progress
 * bar is the best possible outcome, so `load` would paint a finished credential
 * sweep in alarm red and make red mean "error" on one row and "done" on the next.
 * `volume` is the repo's one-hue, no-valence ramp — length carries the
 * comparison, brightness carries the magnitude, and neither makes a health claim.
 * Pass `ramps.savings` if a full bar should read as an achievement rather than as
 * a quantity.
 */
export function LoadingRow({
  label,
  frame,
  width = 12,
  pct,
  value,
  valueWidth,
  ramp = ramps.volume,
  fg,
  labelWidth,
}: LoadingRowProps): ReactNode {
  // Read at RENDER time: `C`/`tokens` are reassigned in place when the terminal
  // theme is detected, and a module-level capture would pin the dark palette.
  const labelFg = tokens.subtle;
  const valueFg = tokens.text;
  const determinate = pct !== undefined;
  const column = value === undefined ? 0 : Math.max(valueWidth ?? 0, displayWidth(value));
  const bar = determinate ? (
    <MeterSpan pct={pct} width={width} ramp={ramp} />
  ) : (
    <ShimmerSpan frame={frame} width={width} {...(fg === undefined ? {} : { fg })} />
  );

  if (labelWidth !== undefined) {
    return (
      <text flexShrink={0}>
        <span fg={labelFg}>{padTo(label, labelWidth)}</span>
        <span> </span>
        {bar}
        {value === undefined ? null : (
          <>
            <span> </span>
            <span fg={valueFg}>{padTo(value, column)}</span>
          </>
        )}
      </text>
    );
  }

  return (
    <text flexShrink={0}>
      {bar}
      {value === undefined ? null : (
        <>
          <span> </span>
          <span fg={valueFg}>{padStartTo(value, column)}</span>
        </>
      )}
      <span> </span>
      <span fg={labelFg}>{label}</span>
    </text>
  );
}
