/**
 * can-draw-tui.ts — the one oracle for "may this process paint a full-screen UI".
 *
 * THIS FILE IMPORTS NOTHING, AND THAT IS LOAD-BEARING, NOT TIDINESS. It is
 * imported STATICALLY by `index.ts` (and, later, by the model picker's entry
 * point), which are the two coldest paths in the program. Anything this file
 * pulled in would be pulled into `index.ts`'s static graph — and one OpenTUI
 * import there would load a renderer into the MCP stdio path, whose stdout is a
 * protocol. That is the exact hazard `providers/model-ordering.ts:10-18` was
 * created to prevent, one directory over. If this ever genuinely needs an
 * import, the allowlist is a `node:`-prefixed builtin and nothing else.
 *
 * WHY A FUNCTION AND NOT A CONSTANT: `isTTY` is read from the live process, and a
 * module-level `const` would freeze the answer at import time — before the point
 * where anything decides whether to draw.
 *
 * BOTH STREAMS, and both are necessary for different reasons. `stdout` not being
 * a TTY means alternate-screen escapes would land in a stream something else is
 * parsing — `claudish -p --output-format stream-json | jq` reserves that stream
 * for machine-readable output. `stdin` not being a TTY means no keypress can ever
 * arrive, so a picker would block forever waiting for one. The failure of the
 * first is corrupt output; the failure of the second is a hang, and a hang is the
 * worse of the two because it looks like slowness.
 *
 * The rationale above is the reasoning already written out at `index.ts:950-962`
 * for the resume picker, which is where this predicate was an inline `const`.
 */

/** True only when both of our own streams are terminals we may draw on. */
export function canDrawTui(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
