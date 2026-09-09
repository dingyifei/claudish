> The SSE-replay format-translation harness and how to add a regression test.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Test Infrastructure

## Format Translation Test Harness
`packages/cli/src/format-translation.test.ts` — SSE replay tests for the full translation pipeline.

**Fixture-based**: Each `.sse` file in `test-fixtures/sse-responses/` is a captured SSE stream from a real provider response. Tests replay fixtures through the stream parser and assert correct Claude SSE output.

**Helpers**: `parseClaudeSseStream()`, `extractText()`, `extractToolNames()`, `extractStopReason()`, `fixtureToResponse()`

**Adding regression tests**: After extracting fixtures from a debug log, add a `describe("Regression: <model>")` block. Template is at the bottom of the test file.

## A gate must not also gate its own diagnostic

`e2e-channel.test.ts` Group 2 spawns a real `claude -p`, so it needs a working credential.
It gates on a genuine probe — one tiny headless prompt, treating a login/credential error as
"not usable" — which is the right design. But the probe itself lived inside
`if (!SKIP_LIVE_E2E) { … }`.

So running with `CLAUDISH_SKIP_LIVE_E2E=1` — which is the normal, recommended way to run this
suite — meant the probe never executed, `claudeUsable` stayed `false`, and Group 2 reported:

```
[e2e-channel] Group 2 SKIPPED — `claude -p` is unavailable or not authenticated
```

**That message is a claim about the environment that the environment was never asked.** It is
indistinguishable from the same message on a machine with genuinely no credential, and it was
repeated in status reports for hours as "environment-gated" when the real answer was "not
asked". Removing the flag ran the probe and recovered the tests; with a credential present,
all 15 in the file pass with zero skips.

**The general form: a mechanism that reports state must not be disabled by the same switch
that disables the work.** Where a skip is conditional, its REASON must be computed
unconditionally, or the skip message must say "not checked" rather than naming a cause. A
diagnostic that is silenced along with the feature cannot tell you why the feature is off —
it can only repeat its default.

Same shape as `team`'s exit 0 (`team-capture.md`): a status whose failure mode is to look
like a confident answer. Prefer "unknown" to a plausible guess in any automated report.

## A fixture must live where the test lives, never in scratch space

`channel/test-helpers/captured-stream-json.ts` reads real captured stream-json frames at
MODULE LOAD, via an IIFE. Its `PROBE_DIR` originally pointed at
`ai-docs/sessions/dev-arch-*/probes/` — where the probe that recorded them happened to write.

`.gitignore:56` excludes `ai-docs/sessions/`. So the files existed on exactly one machine and
in no clone. In CI the `readFileSync` threw during module init, the exported consts were never
assigned, and every test in the file died with:

```
ReferenceError: Cannot access 'CAPTURED_ASSISTANT_FRAME' before initialization.
```

which names a symbol, not a missing file — the real cause is two frames up the stack.

Fixed by copying both captures VERBATIM into `packages/cli/src/channel/test-helpers/captures/`
and pointing `PROBE_DIR` at `resolve(import.meta.dir, "captures")`. Byte-identical: fixtures
come from real logs and must never be regenerated or reformatted in a move.

**The rule, stated generally:** a fixture is BY DEFINITION something meant to outlive the
session that produced it, so a session directory is never its home — however convenient that
is at capture time. CLAUDE.md already warns that `ai-docs/sessions/` "does not survive a fresh
clone or `git worktree remove`" and that "three write-ups already died this way". This was the
fourth, and the first to take a test gate down rather than a document.

The trap is that it is invisible locally in the only direction that matters: the suite is
green on the machine that recorded the captures and red everywhere else, so local green is not
weaker evidence than CI red — it is ACTIVELY MISLEADING. Same family as the gated diagnostic
above: a signal that reports success because the question could only be asked where the answer
was already yes.

Cheap check before trusting any new fixture: `git ls-files <path>` must list it, and
`git check-ignore -v <path>` must say nothing.

## A red local suite may just be a newer bun than CI pins

`.github/workflows/test.yml` pins `bun-version: "1.3.10"`. A developer machine on a
newer bun runs different bundled Unicode tables, and `tui/viz/color.test.ts` measures
claudish's `displayWidth` fallback against a RUNTIME oracle. So the oracle moves with
the runtime while the fallback table does not.

Measured 2026-09-04 on bun 1.4.0: two `displayWidth` tests fail locally on
U+2630–U+2637 and U+268A–U+268F (Yijing trigram and monogram symbols), whose East
Asian Width classification differs between the two bun releases. The same commit's
`Tests` run on main is GREEN on the pinned 1.3.10.

**Do not "fix" the width table to match the newer bun** — that inverts the failure and
breaks the pinned CI. Before treating any hermetic red as a regression, check the local
runtime against the pinned one and look at whether CI is green on the same SHA. A test
that compares against a runtime-provided oracle is only as stable as the runtime.

Distinct from the credential-gated live tests, which skip in CI and are documented as
non-blocking; this one is hermetic and still environmental.
