# Architecture Brainstorm Consensus — how claudish should run Claude Code

Vote semantics: APPROVE = "adopt magmux PTY panes as the primary channel transport".
REJECT = "a different architecture" (named in SUMMARY).

| Model | Vote | Conf | Recommended architecture |
|---|---|---|---|
| gemini-3.7-flash | REJECT | 10 | stream-json over pipes; magmux optional interactive mode only |
| kimi-k3 | REJECT | 9 | Duplex stream-json (`--output-format stream-json --verbose --input-format stream-json`); magmux opt-in human-watch; Agent SDK long-term |
| gpt-5.6-sol | REJECT | 9 | Bidirectional stream-json pipes + shared session supervisor; magmux explicit optional terminal mode |
| grok-4.6 | REJECT | 9 | stream-json pipes as data plane; magmux opt-in interactive CONTROL plane, never primary |
| glm-5.3 | REJECT | 8 | stream-json + turn-based send_input + get_events/get_diagnostics + MCP progress keepalive + group-kill cancel |

Result: 0/5 for magmux-as-primary. **5/5 consensus on stream-json over pipes**, magmux demoted
to an opt-in interactive/attach mode. This is agreement, not a split.

## Independent convergence (strong signal)

The panel was NOT told about `--input-format stream-json`, `--include-partial-messages`, or
`--include-hook-events` — those were found in local `claude --help` AFTER launch, and external
models cannot inspect this machine. kimi-k3 named `--input-format stream-json` anyway, and
gpt-5.6-sol / glm-5.3 independently specified duplex input frames. Five models and a local
flag inspection reached the same design separately.

## Why magmux loses for CHANNEL sessions (it stays right for `team` grid)

- "TUI scraping is not a protocol" (4/5). A rendered screen is a lossy projection; tokens and
  cost are unrecoverable from it.
- `awaiting_input` != "the model asked a question" — magmux idle detection is not semantic.
- Alt-screen Claude Code has ZERO scrollback, so `get_output` cannot read the pane.
- One magmux instance per independent session is the wrong concurrency model (socket + PTY +
  control-panel overhead per session, in CI, headless, concurrent).
- `send_input` is structurally incompatible with the current `--stdin`/`-y` spawn regardless
  of transport — it needs stdin held open.
- magmux retains exactly one advantage: a human-watchable grid. That is a `team` concern.

## Everything required already exists in-tree

Verified present in `packages/cli/src/team-orchestrator.ts`:
`createAssistantTextCapture` (stream parser), `classifyRunOutput` (terminal-state oracle),
`CLAUDISH_TOKEN_FILE` (token accounting), `redactSecrets`, `persistErrorLog`,
`meaningfulStderr`, `STDOUT_TAIL_LIMIT`. Plus `captureUpstreamError` /
`CLAUDISH_UPSTREAM_ERROR_LOG` in `handlers/composed-handler.ts` (no-op when unset).
Also `packages/cli/src/session/` (~1,800 lines) already parses Claude Code's JSONL transcripts,
and `claude-runner.ts` already writes a `--settings` overlay (the hook injection point).

The channel path uses none of it. This is reuse, not new surface.

## Lineage of the defect

`session-manager.ts:7` — "Spawn pattern mirrors team-orchestrator.ts (line 202)". True when
written; `team` then moved to stream-json and later to magmux, and the copy never followed.
`SignalWatcher`'s glyph regexes reconstruct information print mode discarded two lines earlier
in the same file.

## Concrete shape (converged)

Spawn: keep `-p`, add `--output-format stream-json --verbose --include-partial-messages
--include-hook-events --input-format stream-json`. Do NOT close stdin (`session-manager.ts:177`)
— it becomes the `send_input` control channel. Delete `SignalWatcher`'s regex machine; parse
NDJSON events instead. Terminal state from `classifyRunOutput`, not exit code 0. Tokens via
`CLAUDISH_TOKEN_FILE` → `SessionInfo.tokensUsed`. Persist bounded, `redactSecrets`-applied
`events.jsonl` per session so a failure that already happened is readable through MCP.

## Back-compat (the one real breaking edge)

`get_output` currently returns raw stdout. Under stream-json, stdout is NDJSON. Consensus:
`get_output` keeps "assistant prose" semantics (what it always intended) via
`createAssistantTextCapture`; raw events go to a new `get_events`, diagnostics to
`get_diagnostics`. `SessionInfo` field names survive and finally get honest writers; new
statuses are additive. Tests pinning event NAMES keep passing; any test asserting
"exit 0 => completed" must change, and should.

## Open items flagged by the panel

- stream-json schema drift across `claude` versions (glm-5.3)
- multi-frame stdin reliability unverified; resume-based fallback mitigates (glm-5.3)
- mid-turn blocking permission prompts may still need the magmux attach path when
  auto-approve is off (glm-5.3)
- Claude Agent SDK as the long-term runner behind the same interface (kimi-k3)
- CORRECTED: the transcripts DO exist. They are under the sessions' `work_dir`
  (`~/.claude/projects/-Users-jack-mag-magus-magus-src--claude-worktrees-style/`), not
  claudish's project dir. `5aba8f1f-….jsonl` (gpt-5.6-sol, 432 events, 152 assistant msgs,
  68,529 output tokens, 19.88M input) and `6250c4b6-….jsonl` (k3, 299 events, 89 assistant
  msgs, 25,366 output tokens, 6.29M input). Start timestamps match meta.json startedAt to
  within ~1s. Session A's LAST event is 5 ms before its completedAt — it was actively working
  when SIGTERM landed, not hung.
  Nothing was lost upstream: 15 minutes of real, billed, tool-using work was discarded at
  CAPTURE and relabelled `turnsCompleted:0, tokensUsed:0, status:"completed"`.
  The earlier "no transcript" claim was an error of mine — the find returned these files and
  I misread the path as an unrelated repo.

## Status
Internal dev:architect (repo access, plus the transcript/hooks and streaming-flags axes)
still running; not counted above.
