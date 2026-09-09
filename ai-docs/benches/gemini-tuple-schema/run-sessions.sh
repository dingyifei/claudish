#!/bin/bash
# Run N independent interactive claudish sessions against Antigravity, send the
# same prompt to each, and record what the tuple tool actually received.
#
# Why interactive and not `-p`: the bug lives in the tool schema claudish sends,
# and a unit test only asserts on a payload claudish itself built. The only
# witness that the MODEL could use the schema is a real session.
#
# Fresh session per run: reusing one would let earlier turns bias later answers,
# which is the variable under test.
#
# Completion is detected by the MCP tool APPENDING to $RECORD, never by grepping
# the TUI. See the two measurement bugs in
# ai-docs/reports/gemini-tool-schema-support-20260903.md — both produced silence,
# which is indistinguishable from failure.
#
# usage: run-sessions.sh <count> <label> <record.jsonl> <errors.log> [model]

set -u

COUNT="$1"
LABEL="$2"
RECORD="$3"
ERRLOG="$4"
MODEL="${5:-ag@gemini-3.6-flash-high}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE" && git rev-parse --show-toplevel)"
CLI="$REPO/packages/cli/dist/index.js"

PROMPT='Call the query_rows tool once on collection "orders" with two where clauses: cost greater than 500, and status equals shipped.'

if [ ! -f "$CLI" ]; then
  echo "missing $CLI — run 'bun run build' first" >&2
  exit 1
fi

touch "$RECORD" "$ERRLOG"

for i in $(seq 1 "$COUNT"); do
  S="agprobe-${LABEL}-${i}-$$"
  BEFORE=$(wc -l <"$RECORD" | tr -d ' ')

  tmux new-session -d -s "$S" -c "$HERE" -x 200 -y 60

  # Wait for the interactive shell before typing. An export sent into a zsh that
  # has not finished starting is silently lost, which leaves the MCP server with
  # no record path and makes a successful tool call look like no call at all.
  for _ in $(seq 1 30); do
    tmux capture-pane -p -t "$S" 2>/dev/null | grep -q '\$\|❯\|%' && break
    sleep 1
  done
  sleep 1

  tmux send-keys -t "$S" "export TUPLE_PROBE_RECORD='$RECORD' TUPLE_PROBE_LABEL='$LABEL'" Enter
  sleep 1
  tmux send-keys -t "$S" "bun run $CLI --model $MODEL --mcp-config ./mcp-config.json --allowedTools mcp__tuple-probe__query_rows" Enter

  # Wait for the Claude Code TUI before typing into it.
  for _ in $(seq 1 60); do
    tmux capture-pane -p -t "$S" 2>/dev/null | grep -q "bypass permissions" && break
    sleep 1
  done

  # Type the prompt, pause, THEN press Enter. Sending text and Enter in one call
  # makes Claude Code's TUI read the burst as a paste: the text lands in the input
  # box and is never submitted, which looks exactly like the model ignoring it.
  tmux send-keys -t "$S" -l "$PROMPT"
  sleep 2
  tmux send-keys -t "$S" Enter

  OK=0
  for _ in $(seq 1 100); do
    NOW=$(wc -l <"$RECORD" | tr -d ' ')
    if [ "$NOW" -gt "$BEFORE" ]; then OK=1; break; fi
    if tmux capture-pane -p -t "$S" 2>/dev/null | grep -q "API Error"; then
      {
        echo "===== ${LABEL} run ${i}: API ERROR ====="
        tmux capture-pane -p -t "$S" -S -60 2>/dev/null | grep -A4 "API Error"
        echo
      } >>"$ERRLOG"
      OK=2
      break
    fi
    sleep 1
  done

  if [ "$OK" = "0" ]; then
    # Dump the screen. A silent timeout is indistinguishable from a silent
    # success, and the pane is the only thing that can say which happened.
    {
      echo "===== ${LABEL} run ${i}: NO TOOL CALL, NO ERROR (timed out) ====="
      tmux capture-pane -p -t "$S" -S -60 2>/dev/null | grep -v '^[[:space:]]*$'
      echo
    } >>"$ERRLOG"
  fi

  tmux kill-session -t "$S" 2>/dev/null
done

echo "done ${LABEL}: ${COUNT} runs"
