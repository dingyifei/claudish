/**
 * picker-cancelled.ts — the two errors the interactive model picker can end with.
 *
 * THIS FILE IMPORTS NOTHING, for the same load-bearing reason as its neighbour
 * `can-draw-tui.ts`: it is imported STATICALLY by `model-selector.ts` and by
 * `index.ts`, so anything it pulled in would join the cold-start graph, and an
 * OpenTUI import here would put a renderer in the MCP stdio path. If one of these
 * ever needs an import, the allowlist is a `node:`-prefixed builtin, nothing else.
 *
 * IT LIVES IN `tui/runtime/` RATHER THAN BESIDE THE PICKER, and that placement is
 * the whole design note. `selectModel` throws `PickerCancelled` synchronously, so
 * it needs a STATIC import of this class — while a static import from
 * `model-selector.ts` into the picker's own directory is precisely what the
 * import-direction rule forbids (the picker is reached by `await import()` only,
 * which is what keeps OpenTUI off the cold-start path). A leaf here satisfies
 * both: the error type is statically importable, the renderer is not.
 */

/**
 * The user declined to pick — Esc, or Ctrl+C inside the picker.
 *
 * NOT AN ERROR CONDITION, despite being an Error. Declining to choose is a
 * legitimate outcome, and the caller's existing prompt-exit handler turns it into
 * a clean exit 0. It is thrown rather than returned so that cancelling unwinds
 * every caller of `selectModel`, whose contract is `Promise<string>` and which
 * therefore has no value to represent "no choice" with.
 */
export class PickerCancelled extends Error {
  constructor(message = "picker cancelled") {
    super(message);
    this.name = "PickerCancelled";
  }
}

/**
 * What to tell a user who asked for a picker in a stream that cannot show one.
 *
 * The exact three lines the non-interactive path already prints, kept here as
 * data so `NoTtyError` and that path cannot drift into telling one user something
 * different from the other. Each names a concrete way forward — the message this
 * replaces was a hang, which named none.
 */
export const NO_TTY_LINES: readonly string[] = [
  "Error: Model must be specified in non-interactive mode",
  "Use --model <model> flag, set CLAUDISH_MODEL env var, or use --profile",
  "Try: claudish --models",
];

/**
 * A picker was requested where nothing can be drawn — piped, redirected, CI, or
 * detached.
 *
 * DELIBERATELY NOT CAUGHT BY THE PROMPT-EXIT HANDLER, unlike `PickerCancelled`.
 * The user did not decline; the environment cannot ask. That has to surface and
 * exit non-zero, carrying the lines above, rather than exiting 0 as a cancel
 * does — an exit 0 with no model chosen is indistinguishable from success, and
 * this whole class of bug is one a headless caller cannot see.
 */
export class NoTtyError extends Error {
  constructor(message = NO_TTY_LINES.join("\n")) {
    super(message);
    this.name = "NoTtyError";
  }
}
