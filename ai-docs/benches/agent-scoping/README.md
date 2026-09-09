# agent-scoping — does `--agent` reach the child?

```bash
madbench preflight ai-docs/benches/agent-scoping/madbench.yaml   # can it run
madbench check     ai-docs/benches/agent-scoping/madbench.yaml   # does it grade anything
madbench           ai-docs/benches/agent-scoping/madbench.yaml   # the real run
```

## Status — VALIDATED

| gate | result |
|---|---|
| `list` | passes |
| `preflight` | **ok — 8 components verified** (needs a credential; `./.env` works) |
| `check` (negative control) | 2/4 failed as required · **0 wrongly passed** · 2 ungradeable — see below |
| real run | **HEALTHY · 1/1 pass · 4/4 checks · $0.0136 · 9.0s** |
| `grade` (positive control) | **4/4 cells reproduced · 0 diverged · control holds** |

### The negative control reports "does NOT hold" — and the guards are still tested

`cost` and `latency` ERROR when the harness reports no metrics, and the mock harness
reports none, so `madbench check` can never exercise them. That is a madbench
limitation, not a defect in this bench: **any** bench carrying those checks reports
the same, including madbench's own `examples/bugfix-add`.

**That is a reason to test them another way, not to wave the red line through.**
Proven by falsification — both bounds set to impossible values, one real run:

    Logic   cost ≤ $0.0001      0.00      <- FAILS, actual $0.0349
    Logic   latency ≤ 1ms       0.00      <- FAILS, actual 8.7s

So both guards demonstrably grade. Re-run that check any time they are changed:
set `threshold: 0.0001` / `threshold: 1`, run once for real, confirm both score
0.00, then `git checkout` the file.

Filed upstream with a suggested fix (have the mock report synthetic metrics above
any plausible bound, or exclude un-controllable checks from the verdict the way
`image:` benches already are):
`/Users/jack/mag/madbench/ai-docs/bug-negative-control-cost-latency.md`

Do NOT "fix" the red line by deleting the guards — they catch real cost and latency
regressions, and the falsification run above is the evidence that they work.

Measured over 3 repeat passes (2026-08-22, `claude-haiku-4-5`):

    cost      $0.0142   spread $0.0135-$0.0168   1.2x   sigma $0.0014
    duration  10.83s    spread 8.95s-10.83s      1.2x   sigma 805ms
    tokens    331 tok   spread 211-371 tok       1.8x   sigma 68 tok

Thresholds are set at ~2x the observed max. If a healthy run crosses one, raise the
bound rather than re-rolling the run.

## Why these settings

- **`sandbox: workspace`, not `home`.** `home` replaces HOME, which hides the
  claude.ai login in `~/.claude`. `workspace` still isolates the working tree, so
  the agent cannot touch the real repo.
- **`--agent Explore`, a BUILT-IN.** Plugin agents (`dev:reviewer`,
  `dev:architect`) live in `~/.claude/plugins` and vanish at sandbox levels that
  replace HOME, so they would fail as `not found` — a harness error, not a graded
  result. The built-in roster is `claude, Explore, general-purpose, Plan,
  statusline-setup`.
- **No `session:file-read` check.** The first real run showed the agent solving
  this with `Bash: grep -r "MARKER = "`, which scores **0 file reads** because
  `session:file-read` counts only dedicated reading tools. Across 3 passes the
  mechanism varied — two greps, one `find` + `Read` — so that check would have made
  the bench FLAKY for reasons unrelated to the behaviour under test. It was the
  check over-specifying HOW instead of WHAT. `contains` already covers the
  anti-cheat: `QUOKKA-7741` appears in exactly one seeded file and nowhere in the
  prompt.

## What this does NOT cover, and where that lives instead

madbench grades what an AGENT did, and `madbench check` enforces it: a cell that
passes under the mock harness is grading nothing. These claudish-internal
behaviours are therefore not honestly expressible here:

| behaviour | covered by |
|---|---|
| native slot resolves `internal` -> `opus` tier | `cli-native-model-normalization.test.ts` + measured e2e |
| `require_pattern` reports a non-voting slot FAILED | `team-orchestrator.test.ts`, and a measured `EMPTY`/`shape_mismatch` run |
| unknown agent rejected before spawn | `agent-availability.test.ts` (10 tests) |
| `rate_limit_event` kept out of the captured answer | `team-stream-capture.test.ts` (3 tests) + a measured 191 B -> 3 B run |

Full evidence: `ai-docs/reports/native-team-slots.md`.
