/** @jsxImportSource @opentui/react */
/**
 * ErrorBanner — a pinned, severity-coloured block of already-formatted lines.
 *
 * It exists because of four measured defects in how this CLI reports a failed
 * model-discovery today (all four visible in one captured frame): the warning
 * renders in the same plain white as body text, so the most severe thing on
 * screen is the least prominent; it is inline flow text rather than a pinned
 * region, so one redraw loses it; the upstream JSON body wraps mid-word; and
 * nothing distinguishes it from ordinary chatter. This component fixes the first
 * three. The fourth is a property of the LIST, not of the banner.
 *
 * TWO TIERS, NEVER COLLAPSED TO ok/fail. Copied from `TestResult`
 * (`tui/types.ts:79-107`), whose own comment says `unavailable` is "deliberately
 * neutral, not red":
 *
 *   · `error`  — an actionable failure: a rejected key, a discovery that failed.
 *                `tokens.error` on a `C.bgError` wash.
 *   · `notice` — expected but notable: an empty dynamic models catalog, a list filtered to
 *                nothing. `tokens.warn`, and NO error wash. A user whose
 *                provider legitimately lists no models has not hit an error, and
 *                painting one teaches them to ignore the red.
 *
 * The two tiers therefore differ in COLOUR as well as in words, which is what a
 * span-level test can assert and a character-frame test cannot see at all.
 *
 * THE CALLER OWNS THE WORDS; THIS OWNS THE CHROME. `lines` arrives formatted and
 * ordered, one row each. Nothing here wraps: pass `width` and each line is
 * `truncate`d to it, which puts an ellipsis in the last column instead of
 * spilling a JSON body across three rows mid-token. Anything too long to fit is
 * the caller's to drop, and the full text belongs in the log, never on screen.
 *
 * BORDERLESS IS THE DEFAULT, and that is a row budget, not a taste. A bordered
 * box spends two rows of chrome; on a 24-row terminal the banner's whole budget
 * is four rows, so a border would leave two rows for three lines that must not
 * be dropped. `bordered` (for a tall terminal) swaps in a full rounded border
 * and a title drawn inside it, costing no extra row for the title.
 *
 * NOT BUILT ON `viz/Panel`, deliberately. `Panel` owns one border colour for the
 * whole app — accent when focused, dim otherwise — and its layout type excludes
 * appearance by construction so a call site cannot restyle it. A severity band
 * needs a RED border, which is precisely the thing `Panel` refuses to express.
 * Same border STYLE, so the two still read as one program.
 */

import type { ReactNode } from "react";
import { A, C } from "../theme.js";
import { displayWidth, truncate } from "../viz/text.js";
import { tokens } from "../viz/tokens.js";
import { BadgeSpan } from "../viz/widgets.js";

export type BannerSeverity = "error" | "notice";

export interface ErrorBannerProps {
  /** `error` = actionable failure; `notice` = expected but notable. */
  severity: BannerSeverity;
  /** Formatted rows, most important first. Never wrapped, never re-ordered. */
  lines: readonly string[];
  /** Usable inner width in columns. Given, every line is truncated to it. */
  width?: number;
  /** Drawn in the border. Only rendered when `bordered`. */
  title?: string;
  /** A full rounded border instead of the 1-column left rule. Costs 2 rows. */
  bordered?: boolean;
  /** A chip at the head of the first row, e.g. `HTTP 401`. */
  badge?: string;
}

export function ErrorBanner({
  severity,
  lines,
  width,
  title,
  bordered = false,
  badge,
}: ErrorBannerProps): ReactNode {
  // NOTHING, not an empty box: an empty flex item still occupies a row, so a
  // banner with no lines would push the footer down by one and leave a black
  // gap where a reader expects content.
  if (lines.length === 0) return null;

  // Read at RENDER time. `C`/`tokens` are reassigned in place when the terminal
  // theme is detected, and a module-level `const` snapshots the dark palette
  // before detection runs — the bug class this repo has hit six times, once
  // visible only in a live screenshot.
  const accent = severity === "error" ? tokens.error : tokens.warn;
  const wash = severity === "error" ? C.bgError : undefined;
  const bodyFg = tokens.text;

  const inner =
    typeof width === "number" && Number.isFinite(width) ? Math.max(1, Math.floor(width)) : null;
  // A badge is drawn INSIDE the first row, so the room it takes has to come off
  // that row's budget or the chip pushes the headline over the edge. Its painted
  // width is `displayWidth(label) + 2` (one space of padding each side, outside
  // the label), plus the one space separating it from the text.
  const badgeCells = badge === undefined ? 0 : displayWidth(badge) + 3;
  const fit = (s: string, reserved: number): string =>
    inner === null ? s : truncate(s, Math.max(1, inner - reserved));

  const body = lines.map((line, i) => {
    const head = i === 0;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: a banner row is position-addressed — its index IS its identity, and the priority order is the caller's contract
      <text key={i} flexShrink={0}>
        {head && badge !== undefined ? (
          <>
            <BadgeSpan label={badge} bg={accent} />
            <span> </span>
          </>
        ) : null}
        <span fg={head ? accent : bodyFg} attributes={A.boldIf(head)}>
          {fit(line, head ? badgeCells : 0)}
        </span>
      </text>
    );
  });

  if (bordered) {
    return (
      <box
        border
        borderStyle="rounded"
        borderColor={accent}
        backgroundColor={wash}
        title={title}
        titleAlignment="left"
        flexDirection="column"
        flexShrink={0}
        overflow="hidden"
        paddingLeft={1}
        paddingRight={1}
      >
        {body}
      </box>
    );
  }

  // The 1-column left rule: severity colour, zero chrome ROWS. `title` has no
  // border to live in here and is deliberately not rendered as a row of its own
  // — the headline already carries the display name.
  return (
    <box
      border={["left"]}
      borderStyle="single"
      borderColor={accent}
      backgroundColor={wash}
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
      paddingLeft={1}
    >
      {body}
    </box>
  );
}
