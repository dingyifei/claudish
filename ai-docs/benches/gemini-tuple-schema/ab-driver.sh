#!/bin/bash
# A/B two versions of gemini-schema.ts over N live sessions each.
#
# Each half rebuilds first, so the running dist always matches the label being
# recorded. Both revisions are git revisions, so this is reproducible after the
# scratch files are gone.
#
# usage: ab-driver.sh <rev-a> <label-a> <rev-b> <label-b> [runs]
#   e.g. ab-driver.sh 6c5800b collapse-to-string HEAD union 3
#
# Restores the working tree copy of gemini-schema.ts on exit. It uses `git show`
# (read-only) and a file copy, never `git checkout` or `git stash` — this repo is
# worked in worktrees that share one index.
set -u

REV_A="$1"; LABEL_A="$2"; REV_B="$3"; LABEL_B="$4"; RUNS="${5:-3}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE" && git rev-parse --show-toplevel)"
SRC="$REPO/packages/cli/src/handlers/shared/gemini-schema.ts"
REL="packages/cli/src/handlers/shared/gemini-schema.ts"

RECORD="$HERE/ab-record.jsonl"
ERRLOG="$HERE/ab-errors.log"
BACKUP="$(mktemp)"

cp "$SRC" "$BACKUP"
trap 'cp "$BACKUP" "$SRC"; rm -f "$BACKUP"; echo "restored working tree copy"' EXIT

: >"$RECORD"
: >"$ERRLOG"
cd "$REPO" || exit 1

run_half() {
  local rev="$1" label="$2"
  git show "${rev}:${REL}" >"$SRC" || { echo "cannot read ${rev}:${REL}" >&2; exit 1; }
  bun run build >/dev/null 2>&1 || { echo "build failed for $label" >&2; exit 1; }
  echo "built $label ($rev)"
  "$HERE/run-sessions.sh" "$RUNS" "$label" "$RECORD" "$ERRLOG"
}

run_half "$REV_A" "$LABEL_A"
run_half "$REV_B" "$LABEL_B"

echo "=== A/B complete: $RECORD ==="
