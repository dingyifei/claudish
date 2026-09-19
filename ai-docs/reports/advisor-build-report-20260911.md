# Advisor build report (archived)

Archived on 2026-09-11 from the gitignored build session
`ai-docs/sessions/dev-feature-advisor-any-model-20260909-0001/report.md`, which
`git worktree remove` deletes. Everything below the rule is verbatim.

Read it as a record of the build, not as a description of later code:

- It describes branch `worktree-advisor-support`, released as `v9.3.0` (merge `ee2c995`).
- Its session-relative paths (`validation/phase7-*`, `reviews/`, `tests/`) no longer exist.
  Two of them were archived next to this file:
  `tests/mutation-proofs.md` is `advisor-mutation-proofs-20260911.md`, and the scope record is
  `advisor-scope-decisions-20260910.md`. The raw real-run logs were not archived.
- Its "macOS bridge suite does not run" note is true only for a local run on `bun` 1.4.0.
  CI pins `bun` 1.3.10, where the CLI suite is green and the bridge suite runs
  (run `34544453952`: `Ran 20 tests across 1 file`).
- Rationale: `ai-docs/architecture/advisor.md`. Lessons: `advisor-any-model-verification-20260911.md`.

---

# Advisor for any main-model configuration — build report

**Branch:** `worktree-advisor-support` · **Base:** `ad326c3` · **Plan:**
`docs/plans/2026-09-09-claudish-advisor-any-model.md` (magus repo)
**Depth:** full · **Automation:** autonomous

## What the plan asked for, and what is true now

`claudish --advisor "<models>"` had to work whatever main model was chosen.

| Configuration | Plan said | Verified now |
|---|---|---|
| No `--model` | "works today" | **Was false.** Claude Code offered no advisor tool at all, on this branch AND on the released build. Now works: 3 calls, all `upstream`. |
| Bare Anthropic name | did not work | Works: 2 calls, `upstream`, advisor beta flag stripped. |
| Foreign model | did not work | Works: 2 calls, `upstream`, real advice while the main loop ran on Grok. |
| Panel plus collector | — | Works: per-member records, collector `upstream`, a failed member named in `failedModels`. |
| `--advisor` absent | no advisor traffic | Verified: no tool, no swap, no records, no log file. |

## The root cause the plan did not know

Claude Code builds its advisor tool spec only when an advisor MODEL is
configured, and it has no default. Claudish set the experimental env var, which
bypasses only the RANK checks, and never supplied a model. So the tool was never
offered, in any configuration, before or after the plan's changes. A control run
on the RELEASED build behaved identically.

The beta header `advisor-tool-2026-03-01` is sent regardless, which is why the
advisor looked active when it was not.

Claudish now passes `--advisor sonnet` to the child, and leaves the user's own
`advisorModel` alone when they have one.

## What was built

| Area | Change |
|---|---|
| Capture | Advisor tool-use ids are captured by tool NAME, not the `toolu_` prefix. Foreign parsers mint `call_*` / `tool_*`; the old regexes recorded nothing, so the advisor silently did nothing on every foreign provider. SSE events are reassembled across chunk boundaries, and non-stream JSON is scanned too. |
| Dispatch | `--advisor` no longer implies `--monitor`. A decorator wraps the handler `getHandlerForRequest` returns, swaps Claude Code's server advisor tool for a function tool BEFORE the inner handler converts the request (foreign converters drop server tools), tees the response to scan it without touching the client's bytes, and rewrites advisor tool_results. |
| Launch | A no-`--model` advisor session keeps the four launch behaviours monitor used to provide: no picker, no required-model exit, no `ANTHROPIC_MODEL=unknown`, native auth preserved. `--monitor` itself is untouched. |
| Provenance | Every panel call writes an `advisor_call` record with an explicit `origin` (`upstream`, `stub`, `absent`), the stub path, route host, status and byte count; every rewrite writes `advisor_rewrite` with `resultOrigin` and `failedModels`. Records go to the always-on log, not only under debug. |
| Failure visibility | Failures reach the model as text naming the model and reason, carry `is_error` on the Anthropic wire, and raise one warning each. Provider error text is sanitised by credential value and by shape first. |
| Startup | A notice names each panel model's host and that it bills per token, the main model and its provider, whether the advisor env var was set by claudish or inherited, and the uncached per-call cost. Predictable failures refuse before a port is bound. |

## Defects found and fixed along the way

Each was found by review or by a real run, not by the original plan.

1. The OpenRouter panel request passed `resolveModelNameSync` its arguments in
   the wrong order and sent the returned object as the model id. Every
   OpenRouter panel member failed.
2. A retried request re-ran and re-billed the whole panel, in a window up to
   90 seconds.
3. Startup refused a Google model the runtime could serve, and accepted a
   placeholder token the runtime rejects. Both halves came from two credential
   lookups; there is now one.
4. The advisor log file was written unscrubbed while the debug mirror was
   scrubbed.
5. The Anthropic collector had no timeout.
6. Subscription-prefixed specs became invalid OpenRouter ids
   (`openai-codex/gpt-5.6-sol`); they now resolve through live catalog data, or
   are refused by name.
7. An in-flight entry could be evicted, after which the log claimed `upstream`
   while the model received an error.
8. The OpenAI route sent `max_tokens`; that endpoint requires
   `max_completion_tokens`, so the plan's own example model returned 400.
9. A bare name could resolve to another provider's id
   (`accounts/fireworks/models/kimi-k3`).
10. **Found by a real run:** the unanswered-advisor detection matched the phrase
    "No such tool available: advisor" in ANY tool_result text, so a model
    running `rg "advisor"` in Bash minted a fake advisor record and a false
    user-visible warning. Text the model wrote is untrusted input.
11. **Found by a real run:** the panel was handed a transcript containing the
    harness's own tool error and answered about it. The panel is now asked the
    advisor's own question, with that one tool_result neutralised by id.
12. **Found by a red test:** claudish's SSE debug logger truncated payloads at
    300 characters, so fixtures extracted from a debug log were unparseable
    mid-JSON. Since the project's documented test workflow extracts fixtures
    from debug logs, every such fixture was at risk. The logger now writes
    payloads verbatim, and the extractor refuses to write a corrupt fixture.
13. **Pre-existing, found by an experiment:** a nested claudish inherits
    claudish's own placeholder `ANTHROPIC_AUTH_TOKEN`, and the native-auth path
    forwarded it, so Anthropic answered 401. Reproduced on the released build.
    Only exact placeholder values are scrubbed.

## Test results

| Suite | Result |
|---|---|
| Full suite, this branch | 3239 pass / 14 skip / 2 fail, 3255 tests across 211 files |
| Full suite, clean base `ad326c3` | 3156 pass / 14 skip / 4 fail plus 1 error |
| `typecheck` | exit 0, no errors |
| `lint` | exit 0, no errors |

Both failures are the `displayWidth` Unicode-oracle tests in
`tui/viz/color.test.ts`, which also fail on the clean base. No live-network
flake and no contention failure appeared in the final run, and **no new failure
is attributable to this work**. The macOS bridge suite does not run, because the
root script chains the two suites with `&&` and the base is already red.

New advisor tests, all green: capture 5, failures 5, panel prompt 5,
decorator 9, routing and state 13, startup 23, runner 19, SSE log payload 3,
plus the existing 40.

Mutation proofs: 30 bugs were reintroduced one at a time, each in a file backed
up by copy and restored byte for byte afterwards, running only the test that
should catch it. **25 were caught.** `tests/mutation-proofs.md` records every
planted edit and the failing test names.

Two results are worth stating plainly rather than averaging away:

- The first "exactly once" test passed with its own guard deleted, because
  swapping an already-swapped body changes nothing. A replacement test was
  written that observes a side effect which doubles, and the mutation is caught
  by that test only. Without mutation testing the guard would have looked
  covered while guarding nothing.
- Four fixes had no test at all: the OpenRouter id resolution, the OpenAI token
  parameter, the collector alias, and the SSE log cap. Each of those bugs was
  found by a REAL RUN rather than by a failing test, which is how a fix arrives
  without a guard. Tests were then written for all four, and the four mutations
  re-run: every one is now caught. One caveat is recorded rather than smoothed
  over — two of the three SSE-log tests derive their expectations from the
  exported constant, so they would follow it if it changed; the literal
  5000-character test is the real regression guard.

Across all rounds: 34 mutations attempted, 29 caught on the first attempt, and
the 5 that were not are each explained in `tests/mutation-proofs.md` — one
because its test was too weak (replaced, then caught) and four because the fix
had no test yet (written, then caught).

## Evidence

- Real runs: `validation/phase7-*` (before the advisor model, including a
  released-build control), `validation/phase7b-*` and `phase7c-*` (after),
  `validation/authexp-*` (the placeholder experiment). Each has the pane output,
  the claudish debug log and the origin records.
- Code review: four models, `reviews/code-review/`, 0 CRITICAL, all HIGH
  findings dispositioned in `consolidated.md`.
- Design review: two rounds, `reviews/plan-review*/`. The first rejected the
  design over the `toolu_` prefix defect; the second over breaking configuration
  A at launch.
- Tests: `tests/mutation-proofs.md` records the planted bug behind each guard.

## Behaviour changes a user may notice

- `--advisor` no longer forces the main loop onto the native handler. A profile
  mapping now applies to an advisor launch, where it used to be overridden. This
  follows the plan's requirement that the advisor must not change main-model
  routing; the startup notice names the provider that serves the main model.
- Panel calls are billed per token at the named host and never use a
  subscription. This was always true and is now stated at startup.
- A configuration that cannot work is refused before a port is bound, instead of
  failing mid-session.

## Known limitations and follow-ups

- Panel calls do not use claudish's subscription-aware routing. Parked in
  `ROADMAP.md`.
- A panel model that returns HTTP 200 with reasoning but no content is recorded
  as a stub. Reasoning-only response shapes are not unwrapped.
- The collector's synthesis quality is out of scope; one observed run produced a
  degenerate synthesis from a thin transcript.
- The swallowing `catch` around SSE `JSON.parse` hides parse errors; flagged,
  not changed.
