# Gemini tuple-schema harness

Measures what the Antigravity/Gemini backend accepts in a tool schema, and what
the model then does with it. Findings:
`ai-docs/reports/gemini-tool-schema-support-20260903.md`.

Exists because a unit test cannot see this bug class. It asserts on a payload
claudish itself built, so it agrees with whatever claudish currently does. Only a
live request can say whether the backend accepts the schema, and only a live
session can say whether the MODEL can use it.

## `probe-schema-support.ts` — what does the validator accept?

One minimal `streamGenerateContent` per schema variant, reporting status and the
validator's message.

```
bun run ai-docs/benches/gemini-tuple-schema/probe-schema-support.ts
```

Needs a working `ag@` credential; it reuses the production auth path
(`getValidAntigravityAccessToken`, `setupAntigravityUser`) so an identity failure
cannot be misread as a schema rejection.

**The `control-original-bug` variant MUST fail.** If it passes, the probe is not
reaching the validator and every other result is worthless. Keep a control in any
variant you add.

## `run-sessions.sh` — what does the model do with it?

Runs N fresh interactive claudish sessions, sends one prompt to each, and records
what the tool received.

```
bun run build
ai-docs/benches/gemini-tuple-schema/run-sessions.sh 3 mylabel /tmp/rec.jsonl /tmp/err.log
```

`tuple-mcp-server.ts` exposes one tool whose `where` parameter is an array of
`prefixItems` tuples `[string, string(enum), {}]`. It does no work: it appends one
JSON line per call to `$TUPLE_PROBE_RECORD`, holding the clause and each element's
runtime JSON type.

## `ab-driver.sh` — compare two builds

```
ai-docs/benches/gemini-tuple-schema/ab-driver.sh 6c5800b collapse-to-string HEAD union 3
```

Rebuilds before each half so the running `dist` matches the label. Restores the
working-tree copy of `gemini-schema.ts` on exit, via `git show` and a file copy —
never `git checkout` or `git stash`, because this repo is worked in worktrees that
share one index.

`ab-record-20260903.jsonl` holds the six sessions behind the report.

## Two traps, both of which produce SILENCE

Six runs were discarded to these. A run with no output looks exactly like a run
that failed:

1. An `export` sent into a zsh that has not finished starting is lost. The server
   then has no record path, and successful tool calls leave no trace.
2. Sending prompt text and `Enter` in one `tmux send-keys` makes Claude Code read
   the burst as a PASTE. The text sits in the input box, never submitted.

Both are handled here. If you write a variant, dump the pane on timeout — it is
the only thing that distinguishes the two cases.
