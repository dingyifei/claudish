/** @jsxImportSource @opentui/react */
/**
 * EmptyState — one dim row standing in for a list that has no rows.
 *
 * Promoted from the `emptyBody` helper inside `OnepasswordModal.tsx:652-657`,
 * which was the same three lines closed over a label. It is a component rather
 * than a helper because a second and third screen need it, and because an empty
 * panel is the one state where a UI most easily says nothing at all.
 *
 * SAY WHICH EMPTY IT IS. `nothing here` covers four different situations — still
 * loading, loaded and genuinely empty, filtered to nothing, failed — and a
 * picker that renders the same sentence for all four is exactly the complaint
 * this component's callers exist to fix. The label is the whole component;
 * spend it. `hint` is a second, dimmer row for the way out (`press / to clear
 * the filter`), and is omitted rather than padded when there is nothing to say.
 *
 * A FAILURE IS NOT AN EMPTY STATE. Route those to `ErrorBanner`, which carries a
 * severity tier and a colour; a dim grey line is the wrong prominence for
 * something the user has to act on.
 *
 * TWO SIBLING `<text>`s, not one wrapped string: sibling text nodes lay out
 * normally inside a column box (they overprint only when the box is too short
 * for them), and one `<text>` per row is the rule that keeps Yoga from clawing
 * columns back from the last child.
 */

import type { ReactNode } from "react";
import { tokens } from "../viz/tokens.js";

export function EmptyState({
  label,
  hint,
}: {
  /** Why the list is empty, in the user's terms. */
  label: string;
  /** Optional second row: what to do about it. */
  hint?: string;
}): ReactNode {
  // Read at RENDER time — `tokens` re-snapshots when the terminal theme is
  // detected, and a module-level capture would ship the dark palette only.
  // `tokens.idle` is `C.fgMuted`, byte-identical to the `emptyBody` this came
  // from, and it means "waiting", which is what an empty list mostly is.
  const labelFg = tokens.idle;
  const hintFg = tokens.subtle;
  return (
    <box flexDirection="column" flexShrink={0}>
      <text>
        <span fg={labelFg}>{label}</span>
      </text>
      {hint === undefined ? null : (
        <text>
          <span fg={hintFg}>{hint}</span>
        </text>
      )}
    </box>
  );
}
