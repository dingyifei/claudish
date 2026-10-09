#!/bin/bash
# Wrapper for the launchd LaunchAgent that runs the daily provider health check.
#
# launchd gives a job almost no environment — not the PATH from your shell rc —
# so everything the check needs is spelled out here rather than inherited.
#
# This runs as a LaunchAgent (not a LaunchDaemon) on purpose: an Agent runs
# inside Jack's logged-in GUI session, which is what makes the macOS Keychain
# credential path work without a prompt. A Daemon would run outside the session
# and every keychain read would fail.
#
# If the Mac is asleep at the scheduled time, launchd runs the job on the next
# wake rather than skipping the day.
set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="$HOME/mag/claudish"
LOG_DIR="$REPO/logs/health"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/launchd.log"

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) starting daily provider health check ==="
  cd "$REPO" || { echo "repo missing at $REPO"; exit 2; }

  if ! command -v bun >/dev/null 2>&1; then echo "bun not on PATH"; exit 2; fi
  if ! command -v claudish >/dev/null 2>&1; then echo "claudish not on PATH"; exit 2; fi

  bun scripts/daily-provider-healthcheck.ts --batch 5 --probe-timeout 20
  CODE=$?
  echo "=== exit $CODE ==="

  # Alerting is done here, on this machine, so the whole job survives Cowork
  # being unreachable. healthcheck-notify.sh reads its verdict out of the
  # result.json this run just wrote, and pulls the Slack webhook and SMTP
  # password from the login keychain. A missing credential skips that channel
  # rather than failing the run.
  RUN_DIR=$(ls -1d "$LOG_DIR"/*/ 2>/dev/null | tail -1)
  if [ -n "$RUN_DIR" ]; then
    "$REPO/scripts/healthcheck-notify.sh" "${RUN_DIR%/}" "$CODE" || echo "notify step failed (non-fatal)"
  else
    echo "no run directory produced - nothing to notify about"
  fi
  exit $CODE
} >> "$LOG" 2>&1
