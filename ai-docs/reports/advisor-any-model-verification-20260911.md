# Verifying the any-model advisor — what the evidence actually showed

Date: 2026-09-11. Shipped in v9.3.0. Design and mechanism live in
`ai-docs/architecture/advisor.md`; this file records how the work was verified and
what the verification found, because the two answers differ from what was expected.

## The premise the plan got wrong

The plan assumed `claudish --advisor "<models>"` already worked when no `--model`
was passed, and was broken only for a bare Anthropic name or a foreign model.

That was false in all three cases. Claude Code builds the advisor tool spec only
when an advisor MODEL is configured, and it has no default. Claudish set the
experimental environment variable, which bypasses only the rank checks, and never
supplied a model. So no advisor tool was ever offered, in any configuration. A
control run on the released build behaved identically.

The beta header `advisor-tool-2026-03-01` is sent whatever happens, which is why
the feature looked active while doing nothing. **A header is not evidence that a
tool exists.**

## Why unit tests could not have found most of this

Thirteen defects were fixed. Only one was caught by a failing test. The split is
the finding:

| Found by | Count | Examples |
|---|---|---|
| Code review of the diff | 9 | wrong argument order to `resolveModelNameSync`; a retry re-billing the whole panel; missing collector timeout; an unscrubbed log file |
| A real run | 3 | a fake advisor record minted by a model running `rg "advisor"` in Bash; the panel answering the harness's own error; a nested claudish inheriting its own placeholder token |
| A failing test | 1 | the SSE logger truncating fixtures at 300 characters |

Two of the three real-run findings share a shape: **text the model wrote was
treated as a signal.** Detection matched the phrase "No such tool available:
advisor" anywhere in any tool_result, so any transcript quoting that phrase
triggered it. Both now key on the tool-use id. Model-authored text is untrusted
input and can never be the sole signal.

## The fixture trap

Four capture tests were red against code that worked in production. The cause was
not the parser: `openai-sse.ts` logged each SSE data payload as
`substring(0, 300)`, so any payload longer than that landed in the debug log cut
mid-JSON. The project's documented test workflow extracts fixtures from those
logs, so **every fixture extracted from a debug log was at risk of being silently
corrupt.**

A corrupt fixture is worse than no fixture: the parser's `JSON.parse` throws, a
`catch` swallows it, the tool list stays empty, and the stream ends `end_turn` —
which reads as "the parser dropped the tool call", a plausible and entirely wrong
diagnosis.

Both parsers now log payloads verbatim behind a 1MB backstop that appends an
unmistakable marker if it ever fires. The extractor parses every payload, refuses
to write a turn that does not parse, and exits non-zero. Replacing the corrupt
fixture turned the four tests green **without editing them**, which is what
proved the tests were right and the fixture was wrong.

## Mutation testing: the only proof a guard works

34 mutations were planted one at a time, each in a file backed up by copy and
restored byte for byte, running only the test that should catch it. 29 were
caught on the first attempt. The 5 misses are the useful part:

- **One test was too weak.** The original "swap happens exactly once" test passed
  with its own guard deleted, because swapping an already-swapped body changes
  nothing — the test could not fail. It was replaced by one that observes a side
  effect which doubles, and that test catches the mutation. Without mutation
  testing the guard would have looked covered while guarding nothing.
- **Four fixes had no test at all**: OpenRouter id resolution, the OpenAI token
  parameter, the collector alias, and the SSE log cap. Each of those bugs was
  found by a real run rather than by a failing test, which is exactly how a fix
  arrives without a guard. Tests were written for all four and the four mutations
  re-run; every one is now caught.

One caveat is recorded rather than smoothed over: two of the three SSE-log tests
derive their expectations from the exported constant, so they would follow it if
it changed. The literal 5000-character test is the real regression guard.

## Restating the general lessons

- A guard is unproven until its bug has been reintroduced and the test went red.
  "The test passes" and "the test would catch the bug" are different claims.
- Never use `git checkout` or `git stash` to restore a file during a mutation
  run: the index and stash stack are shared with sibling worktrees. Copy the file
  out and back.
- Live runs and code review find disjoint defect sets. Nine of these thirteen
  defects were invisible to every run that was made; three were invisible to
  every test that existed. Running only one of the two leaves most of them in.
