# Migration: `/multimodel:team` against the new `team` MCP contract

**For:** whoever maintains `plugins/multimodel/commands/team.md` in the magus
marketplace repo.
**Why:** claudish's `team` tool changed in a way that breaks that command. The
two must ship together.
**File to change:** `plugins/multimodel/commands/team.md` (Step 2 and Step 3).

---

## What broke, in one sentence

`team(mode:"run")` no longer waits for the models and no longer returns their
results. It starts them and returns a slot map immediately.

The command currently calls `run` and reads per-model results straight out of
the response. Those results are not there any more, so vote parsing gets a JSON
object with no votes in it and the panel reports INCONCLUSIVE every time.

There is a second, quieter break: `timeout` was removed from the tool schema. The
schema does not set `additionalProperties: false`, so passing it is not an error
— it is silently ignored. The command will look like it still sets a deadline
when nothing reads it.

---

## Why it changed

A `team` slot is a full Claude Code session and can legitimately work for a long
time. The old shape held the MCP tool call open for the whole run, which made the
run's duration the client's problem — a real run was aborted at exactly 1800s of
client idle timeout.

The deadline that existed to bound it was worse: in session
`team-20260827-0015` it killed three of five slots that were all actively
working, because its only progress signal was token flow, which stops during a
local tool call. A model running `go test ./...` looked identical to a hung one.

Nothing terminates a slot on a timer now. The caller polls, looks at the
evidence, and decides. Full rationale: `ai-docs/architecture/team-lifecycle.md`
in the claudish repo.

---

## Step 2 — the call

### Before

```
claudish team(mode="run", path=SESSION_DIR,
  models=[...ALL resolved models, "internal" included...],
  input=VOTE_PROMPT, timeout=180,
  require_pattern="```vote", agent=RESOLVED_AGENT)
```

### After

```
# 1. Write VOTE_PROMPT to SESSION_DIR/input.md first.
# 2. Then:
claudish team(mode="run", path=SESSION_DIR,
  models=[...ALL resolved models, "internal" included...],
  input_file="SESSION_DIR/input.md",
  require_pattern="```vote", agent=RESOLVED_AGENT)
```

Three changes:

- **`timeout` is gone.** Remove it.
- **`input_file` replaces `input`.** Both still work and passing BOTH is a hard
  error, but prefer the file. A vote prompt is 100+ lines and passing it inline
  echoes the whole thing verbatim in the user's terminal, burying every other
  argument in the tool call. The path must be inside the working directory.
- **`require_pattern` is unchanged** and still the point. Keep it.

### What `run` returns now

```json
{
  "started": true,
  "team_session_id": "team-20260827-0015",
  "session_path": "/abs/path/to/SESSION_DIR",
  "slots": { "gpt-5.6-sol": "01", "grok-4.6": "02", "internal": "03" },
  "next": { "status": "...", "cancel": "...", "judge": "..." },
  "note": "..."
}
```

`slots` maps the display model name to its anonymised slot id. That slot id
addresses everything else on disk for that model:

| Path | Contents |
|---|---|
| `<session_path>/response-<slot>.md` | the model's answer — parse votes from here |
| `<session_path>/stats/<slot>.json` | tokens, cost, tool counts |
| `<session_path>/errors/<slot>.log` | stderr and diagnostics, on failure |
| `<session_path>/errors/<slot>-upstream.jsonl` | raw provider error bodies, when any |

---

## Step 2b — the new polling step (this is the part that did not exist)

Between starting the run and parsing votes, poll until every slot has left
`RUNNING`:

```
claudish team(mode="status", path=SESSION_PATH)
```

Returns the full `TeamStatus` plus three added fields:

```json
{
  "startedAt": "...",
  "models": {
    "01": { "state": "COMPLETED", "exitCode": 0, "outputSize": 10988, ... },
    "02": { "state": "RUNNING",   "exitCode": null, ... }
  },
  "idle_seconds_by_slot": { "02": 94 },
  "activity_by_slot":     { "02": "tool_executing" },
  "note": "...",
  "summary": "<rendered result card — present ONLY once the run has settled>"
}
```

**Settled means: no slot in `models` has `state === "RUNNING"`.** That is the
loop condition.

**`summary` is the string the old `run` used to return.** Once the run settles,
`status` carries the same rendered result card — `N/M succeeded`,
`reason=shape_mismatch`, and the rest. If the command's Step 3 was matching on
that text, it can keep doing so; it just reads it from a settled `status`
instead of from `run`.

Bound the loop, and fail loudly rather than looping forever. There is no
server-side deadline any more, so an unbounded poll is an unbounded wait.

---

## Step 2c — deciding whether a quiet slot is stuck

This is the capability the deadline used to take away from you.

- `idle_seconds_by_slot` — seconds since that slot's child last wrote anything.
- `activity_by_slot` — what it is doing: `running`, `tool_executing`,
  `waiting_for_input`, or a terminal state.

**Read them together.** Ninety seconds of silence in `tool_executing` is a build
or a test suite running, and is completely normal. The same ninety seconds in
`running` is a model that stopped mid-answer. The old reaper had no state at all,
which is exactly why it killed the first kind.

Nothing cancels on your behalf. If you decide a slot is wedged:

```
claudish team(mode="cancel", path=SESSION_PATH, slot="02")   # one slot
claudish team(mode="cancel", path=SESSION_PATH)              # the whole run
```

A cancelled slot is recorded with `error.reason === "cancelled"`, which is
distinct from `nonzero_exit`. It is not a defect — it is a decision, and the
report should say so rather than showing the model as crashed.

Suggested default for a vote panel: do not cancel automatically. Report the slot
as still running and let the user decide. Losing a vote to an impatient
auto-cancel is the same failure the deadline used to cause.

---

## Step 3 — parsing votes

Unchanged in substance, different in where the text comes from.

**Before:** per-model results were read from the `run` response.

**After:** read `<session_path>/response-<slot>.md` for each slot in the map
returned by `run`, after `status` reports settled. The vote regex is unchanged:

```
/```vote\s*\n([\s\S]*?)\n\s*```/
```

Failure handling is unchanged too: a slot whose `models[<slot>].state` is
`FAILED` or `EMPTY` did not vote. `error.reason` tells you why —
`shape_mismatch` means it answered but never produced the required block, which
still must NOT be counted as a vote.

---

## What did NOT change

- `require_pattern` and `min_output_bytes` — same semantics, still recommended.
- `agent` — same, still applies to every model in the run.
- `mode:"judge"` — unchanged.
- `mode:"run-and-judge"` — still BLOCKING, and still returns the verdict. If the
  command would rather not implement polling at all, this mode is the drop-in
  path. The trade is that it holds the tool call open for the whole run, which is
  the shape that hit the client's 1800s idle abort.
- Native Claude names (`internal`, `default`, `opus`, …) are still ordinary
  slots and still belong in `models`.

---

## Minimum viable change

If you want the smallest possible diff and are willing to keep the blocking
behaviour:

1. Remove `timeout` from the call.
2. Change `mode:"run"` to `mode:"run-and-judge"`, or keep `run` and add the poll.

If you want the shape the tool is now designed around, implement the poll in
Step 2b — it is what lets the panel survive a slow model instead of losing its
vote.

---

## Version

Ships in claudish **v8.0.0**. The major bump is for this change specifically.
Pin or require `>=8.0.0` once the command is updated, and note that a plugin
updated for v8 will not work against v7.67.x — `input_file` does not exist there
and `run` still blocks.
