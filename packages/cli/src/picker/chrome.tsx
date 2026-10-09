/** @jsxImportSource @opentui/react */
/**
 * picker/chrome.tsx — the dialog frame and the four one-row strips inside it.
 *
 * THEY ARE IN ONE FILE BECAUSE THEY SHARE ONE ROW BUDGET. The dialog is drawn
 * INLINE, in the user's scrollback, so every row it spends is a row of their
 * terminal it consumed and did not give back — a very different economy from a
 * full-screen app, which pays nothing for chrome it draws inside a viewport it has
 * already taken. Seven rows of chrome and eleven of list is the whole allowance
 * (`layout.ts`), and keeping the strips together is what makes that total visible
 * to the next reader instead of scattered across four files that each look cheap.
 *
 * THE DIALOG IS THE ONLY BORDER. The rejected build framed two panels and drew a
 * header strip, a load strip, a filter strip, a stats panel and a footer outside
 * them. One box, one title, one question.
 */

import type { ReactNode } from "react";
import { LoadingRow } from "../tui/components/LoadingRow.js";
import { A, C } from "../tui/theme.js";
import { displayWidth, truncate } from "../tui/viz/text.js";
import { tokens } from "../tui/viz/tokens.js";

/**
 * The bordered box, with its title composed left-and-right on the border line.
 *
 * ONE COMPOSED TITLE, NOT TWO ELEMENTS, because OpenTUI's box draws exactly one
 * `title` and there is no second slot. The status half is padded into the same
 * string, which is what produces `╭─ choose a model ──── 312 models · 24/31 ─╮`
 * out of a single prop.
 *
 * IT IS BUDGETED SHORT ON PURPOSE. MEASURED on the previous build: a title that
 * fills its border exactly is DROPPED — the box renders no title at all rather
 * than a clipped one — so the loudest label on the screen silently became an empty
 * border. Six columns of slack, and the status half is truncated before the name
 * half is, because "choose a model" is the thing the dialog is FOR.
 */
export function Dialog({
  title,
  status,
  width,
  marginLeft,
  children,
}: {
  title: string;
  /** The right-hand group — counts, never a verdict. May be empty. */
  status: string;
  width: number;
  marginLeft: number;
  children?: ReactNode;
}): ReactNode {
  return (
    <box
      marginLeft={marginLeft}
      width={width}
      border
      borderStyle="rounded"
      borderColor={tokens.accent}
      backgroundColor={tokens.bgPanel}
      title={composeTitle(title, status, width)}
      titleAlignment="left"
      flexDirection="column"
      flexShrink={0}
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      {children}
    </box>
  );
}

/**
 * Exported for the width test — the arithmetic, without a renderer.
 *
 * The leading and trailing spaces are NOT decoration: the box draws the title
 * immediately after `╭─`, so without them the border reads `╭─choose a model──`
 * with the words fused to the rule. MEASURED in a frame capture, not guessed.
 */
export function composeTitle(title: string, status: string, width: number): string {
  const room = Math.max(6, Math.floor(width) - 8);
  const left = truncate(title, room);
  if (status === "") return ` ${left} `;
  const right = truncate(status, Math.max(0, room - displayWidth(left) - 3));
  if (right === "") return ` ${left} `;
  const pad = Math.max(1, room - displayWidth(left) - displayWidth(right));
  return ` ${left}${" ".repeat(pad)}${right} `;
}

/**
 * The filter row: what is typed, and what the list is ordered by.
 *
 * FILTER-FIRST, NO SEARCH MODE. Typing narrows the list immediately — the `/`
 * prompt is always drawn and the caret is always live, because a picker's fastest
 * path is a user who already roughly knows what they want typing three letters of
 * it. The previous build made filtering a MODE entered with `/`, which is one more
 * thing the reader has to know before the screen does anything.
 *
 * The right-hand group answers "why is this row at the top" while nothing is
 * typed, and "how much did I just cut" once something is.
 *
 * `idle` IS THE FIRST HALF OF THAT AND IT IS NOT ALWAYS WORTH SAYING. `newest first`
 * explains an ordering the user did not choose and would otherwise wonder about —
 * why `gpt-5.2` sits above `gpt-5`. The PROVIDER list has no such puzzle: its order
 * is the curated `PICKER_ORDER`, which reads as "the obvious ones first" and needs no
 * caption, so it passes `""` and the row is just the prompt until something is typed.
 * Inventing a phrase there would spend a row's right edge on nothing — and it would
 * put a SORT claim on a screen that does not sort, which the reader has no reason to
 * disbelieve.
 */
export function FilterRow({
  value,
  matches,
  total,
  width,
  idle = "newest first",
}: {
  value: string;
  matches: number;
  total: number;
  width: number;
  /** What the right edge says while nothing is typed. `""` says nothing. */
  idle?: string;
}): ReactNode {
  const right = value === "" ? idle : `${matches} of ${total}`;
  const room = Math.max(1, width - displayWidth(right) - 4);
  return (
    <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
      <text>
        <span fg={tokens.accent}>{"/ "}</span>
        <span fg={tokens.text}>{truncate(value, room)}</span>
        <span fg={tokens.accent}>▍</span>
      </text>
      <text>
        {/* Warn only when a list EXISTS and the filter emptied it. `0 of 0` while
            the list is still loading is not a warning, and painting it as one
            teaches the reader to discount the colour everywhere else. */}
        <span fg={value !== "" && matches === 0 && total > 0 ? tokens.warn : tokens.subtle}>
          {right}
        </span>
      </text>
    </box>
  );
}

/**
 * The rule above the footer — OpenTUI's own self-sizing horizontal line.
 *
 * A `flexGrow={1}` box with `border={["top"]}` needs no width arithmetic at all
 * and re-sizes itself on resize (`TabBar.tsx:50-56` uses the same idiom). Dim,
 * because a separator is the purest chrome there is.
 */
export function Rule(): ReactNode {
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <box flexGrow={1} border={["top"]} borderStyle="single" borderColor={tokens.border} />
    </box>
  );
}

/** One footer hint: the key, then what it does. */
export interface Hint {
  key: string;
  label: string;
  /** Dimmed when the action is currently unavailable — shown, never hidden. */
  on?: boolean;
}

/**
 * What a hint row COSTS, in cells — the arithmetic, without a renderer.
 *
 * IT EXISTS BECAUSE THE ROW CLIPS SILENTLY. `Hints` sets `overflow="hidden"`, so a
 * row one cell too wide loses its last characters and nothing errors: the pill
 * construction added one cell per hint and the six-hint failure footer rendered
 * `esc provider` at 80 columns. That was caught in a screenshot, which is the wrong
 * place to catch arithmetic — so the widest hint set any screen can build is now
 * pinned against the dialog's inner width in `ModelPicker.test.tsx`.
 *
 * Each pill is ` key ` + ` label ` with NO cell between the two fills, and the parent
 * box contributes one column of gap between pills.
 */
export function hintsWidth(hints: Hint[]): number {
  if (hints.length === 0) return 0;
  const pills = hints.reduce((sum, h) => sum + displayWidth(h.key) + displayWidth(h.label) + 4, 0);
  return pills + (hints.length - 1);
}

/**
 * Keyboard hints as KEYCAP PILLS — two abutting segments per hint: the key you
 * press, then what it does.
 *
 * A CHIP HERE IS TWO SEGMENTS, NOT ONE BLOCK BESIDE BARE TEXT. The owner, on the
 * shipped build: *"key suggestion, they should be like chips... the key itself
 * brighter colour and label has backdrop but not as bright, create chips"*. So both
 * halves are filled and the KEY half is the brighter one — it is the thing you press
 * — with the label riding a quieter backdrop beside it:
 *
 *     [ esc ][ quit ]      [ ↑↓ ][ move ]      [ a ][ all models ]
 *       ^brighter                 ^quieter
 *
 * THE TWO SEGMENTS MUST ABUT. One space of padding sits INSIDE each fill and there is
 * none BETWEEN them, so the pair reads as one object with two halves; the gap that
 * separates hints from each other is the parent box's `gap={1}`, outside both fills.
 * A space between the backgrounds splits the pill in half and the affordance is gone.
 * This is a sanctioned case of padding inside a fill, for the same reason `ChipCell`
 * centres inside one: the fill IS the object here, not a highlight on a word.
 *
 * ONE `<text>` PER HINT carries both spans — a `<text>` cannot nest in a `<text>`,
 * and a `<span>` outside a `<text>` renders an error page while the process exits 0.
 * This replaced `BadgeSpan`, whose `label + width` contract describes one fill.
 *
 * THE PILL IS QUIET, AND THE TWO EARLIER ANSWERS WERE THE SAME MISTAKE FROM OPPOSITE
 * ENDS. First it was one neutral grey for both themes, which is a chip that is not a
 * chip: `C.chipKeyBg` measures 1.50:1 against a dark page and 2.38:1 against a light
 * one, so on whichever terminal it was not tuned for it melts and the key reads as a
 * faintly tinted word — the owner reported exactly that from a live light-theme run.
 * The fix was one VIVID purple (`#9333ea`) for both themes, which over-corrected:
 * 5.38:1 on a light page made the footer the loudest thing on a screen whose content
 * is a list.
 *
 * BOTH failures were caused by one hex serving two pages. A keycap is an AFFORDANCE —
 * it says a key exists, not that anything is notable — so it takes madbench's
 * near-background idiom (`paramKeyBg` / `paramValBg`: "near-bg", body ink) and it
 * takes it TWICE, once per palette, because "a shade off the page" points up on black
 * and down on white. MEASURED, because a pale fill does NOT survive a dark terminal:
 * `#B8C2D8` is 1.06:1 on true black, worse than the grey already rejected. Dark gets
 * `#474F63` / `#292D36` (2.57:1 and 1.52:1 off the page, 1.69:1 between them); light
 * gets `#B8C2D8` / `#E4E8F2` (1.79:1 and 1.23:1, 1.46:1 between). Every one of those
 * numbers is pinned by `theme-contrast.test.ts`, including a CEILING — the gate that
 * would have caught the purple.
 *
 * THE INKS ARE STATED, never left to `pickInk`, which reads LUMINANCE alone and would
 * flip on a near-background fill. Each palette declares fill and ink together. All
 * four are read at RENDER time — a module-level `const` here ships one palette's
 * whole construction to the other theme.
 *
 * AN UNAVAILABLE ACTION LOSES THE PILL RATHER THAN BEING HIDDEN — dim text, no fill,
 * so "there is a key here but not now" is visibly different from both a live key and
 * an absent one. Every action is one key and every key is here.
 */
export function Hints({ hints }: { hints: Hint[] }): ReactNode {
  return (
    <box flexDirection="row" height={1} gap={1} flexShrink={0} overflow="hidden">
      {hints.map((h) =>
        h.on === false ? (
          <text key={h.key} flexShrink={0}>
            {/* Same cell count as the pill it replaces, so a hint turning on and off
                does not shuffle the row. */}
            <span fg={tokens.trace}>{` ${h.key}  ${h.label} `}</span>
          </text>
        ) : (
          <text key={h.key} flexShrink={0}>
            <span fg={C.keycapKeyFg} bg={C.keycapKeyBg} attributes={A.bold}>{` ${h.key} `}</span>
            <span fg={C.keycapLabelFg} bg={C.keycapLabelBg}>{` ${h.label} `}</span>
          </text>
        )
      )}
    </box>
  );
}

/** One in-flight task, as the loading dialog draws it. */
export interface LoadTask {
  /** Stable identity — also the React key. */
  id: string;
  label: string;
  /** 0–100 for a determinate meter; omit for a shimmer. NEVER an invented denominator. */
  pct?: number;
  /** The figure after the bar: `8/31 checked`, `discovering…  3.2s`. */
  value?: string;
}

/**
 * The loading dialog's body: one named row per operation actually running.
 *
 * THE SHAPE OF EACH ROW IS THE HONESTY CONTRACT, and it is chosen by what the
 * caller can measure, not by what looks busiest:
 *
 *   · The credential sweep has a real denominator — the provider list is derived
 *     synchronously, so `done/total` is work done over work TOTAL. It gets the
 *     one determinate meter in the whole picker, and it EARNS it: a bounded value
 *     with real variance over time is the one thing a gradient bar is for.
 *   · The catalog warm races a 5 s wait against an 8 s refresh. Two numbers, so no
 *     single denominator a bar could honestly be drawn against — shimmer.
 *   · Discovering one provider's models gets a deadline bar ONLY on the GET half, whose
 *     `FETCH_TIMEOUT_MS` is published, and the label says `deadline` because a
 *     deadline is not progress. The three fetcher providers publish nothing, so
 *     they get elapsed and a shimmer. Inventing 5 000 ms for Devin would be a
 *     guess rendered as a fact.
 */
export function LoadTasks({
  tasks,
  frame,
  labelWidth,
  barWidth,
}: {
  tasks: LoadTask[];
  frame: number;
  labelWidth: number;
  barWidth: number;
}): ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      {tasks.map((t) => (
        <LoadingRow
          key={t.id}
          label={t.label}
          frame={frame}
          width={barWidth}
          labelWidth={labelWidth}
          // `running`, NOT `ShimmerSpan`'s default `warn`. MEASURED in the light
          // palette, where `warn` is `#c2410c` and the catalog shimmer read as a
          // rust-red alarm bar — the one hue this app spends on `SUB` and on an
          // unverified `catalog` row. A fetch in flight is not a warning, and it
          // now matches the determinate meter's blue ramp beside it.
          fg={tokens.running}
          {...(t.pct === undefined ? {} : { pct: t.pct })}
          {...(t.value === undefined ? {} : { value: t.value })}
        />
      ))}
    </box>
  );
}
