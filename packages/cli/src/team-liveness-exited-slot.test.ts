import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TeamHandle,
  type TeamStatus,
  cancelTeamRun,
  getStatus,
  setupSession,
  startModels,
  teamSlotActivity,
  teamSlotIdleSeconds,
  teamSlotLiveBytes,
} from "./team-orchestrator.js";

// REGRESSION: team status reported exited slots as `waiting_for_input` with a growing idle clock — Fixed in /dev:fix session dev-fix-20260912-213141-f1fb0c1c

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const spawnPlanner = async () => ({ pinned: new Map<string, string>() });

let tempRoot: string;
let fakeDir: string;
let fakeClaudish: string;
let slowReleasePath: string;
let originalClaudishBin: string | undefined;
let handles: TeamHandle[];

async function waitForSlotToStop(
  sessionPath: string,
  slotId: string,
  limitMs = 3_000
): Promise<TeamStatus> {
  const deadline = Date.now() + limitMs;
  let status = getStatus(sessionPath);

  while (status.models[slotId]?.state === "RUNNING" && Date.now() < deadline) {
    await delay(10);
    status = getStatus(sessionPath);
  }

  if (status.models[slotId]?.state === "RUNNING") {
    throw new Error(
      `slot ${slotId} did not stop within ${limitMs}ms; status=${JSON.stringify(status)}`
    );
  }
  return status;
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "team-liveness-exited-slot-test-"));
  fakeDir = mkdtempSync(join(tmpdir(), "fake-claudish-liveness-"));
  fakeClaudish = join(fakeDir, "claudish");
  slowReleasePath = join(tempRoot, "release-slow");
  originalClaudishBin = process.env.CLAUDISH_BIN;
  handles = [];

  const fixturePath = join(
    import.meta.dir,
    "test-fixtures/stream-json/haiku-post-answer-turn.jsonl"
  );
  writeFileSync(
    fakeClaudish,
    `#!/bin/sh
model=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model)
      model="$2"
      shift 2
      ;;
    --model=*)
      model="\${1#--model=}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
cat > /dev/null
case "$model" in
  fast-model)
    cat "${fixturePath}"
    ;;
  slow-model)
    attempts=0
    while [ ! -f "${slowReleasePath}" ] && [ "$attempts" -lt 400 ]; do
      sleep 0.05
      attempts=$((attempts + 1))
    done
    cat "${fixturePath}"
    ;;
  *)
    printf 'unexpected model: %s\n' "$model" >&2
    exit 2
    ;;
esac
exit 0
`,
    "utf-8"
  );
  chmodSync(fakeClaudish, 0o755);
  process.env.CLAUDISH_BIN = fakeClaudish;
});

afterEach(async () => {
  writeFileSync(slowReleasePath, "", "utf-8");
  for (const handle of handles) {
    await cancelTeamRun(handle.teamSessionId);
    await handle.done;
  }

  if (originalClaudishBin === undefined) {
    delete process.env.CLAUDISH_BIN;
  } else {
    process.env.CLAUDISH_BIN = originalClaudishBin;
  }
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(fakeDir, { recursive: true, force: true });
});

describe("team slot liveness", () => {
  it("omits an exited slot while another slot is still running", async () => {
    const sessionPath = mkdtempSync(join(tempRoot, "exited-slot-"));
    setupSession(sessionPath, ["fast-model", "slow-model"], "Keep the slow slot alive.");
    const handle = await startModels(sessionPath, {
      captureMode: "stream-json",
      spawnPlanner,
    });
    handles.push(handle);

    const fastSlot = handle.slots["fast-model"];
    const slowSlot = handle.slots["slow-model"];
    const status = await waitForSlotToStop(sessionPath, fastSlot);
    if (status.models[slowSlot]?.state !== "RUNNING") {
      throw new Error(
        `slow slot was not RUNNING when fast slot exited; status=${JSON.stringify(status)}`
      );
    }

    await delay(1_100);
    const laterStatus = getStatus(sessionPath);
    if (laterStatus.models[slowSlot]?.state !== "RUNNING") {
      throw new Error(
        `slow slot was not RUNNING after idle-clock window; status=${JSON.stringify(laterStatus)}`
      );
    }

    const activity = teamSlotActivity(handle.teamSessionId);
    const idleSeconds = teamSlotIdleSeconds(handle.teamSessionId);
    const liveBytes = teamSlotLiveBytes(handle.teamSessionId);
    if (activity === null || idleSeconds === null || liveBytes === null) {
      throw new Error(
        "live slot telemetry unexpectedly disappeared while the slow slot was RUNNING"
      );
    }

    expect(activity).not.toHaveProperty(fastSlot);
    expect(idleSeconds).not.toHaveProperty(fastSlot);
    expect(liveBytes).not.toHaveProperty(fastSlot);
    expect(activity).toHaveProperty(slowSlot);
    expect(idleSeconds).toHaveProperty(slowSlot);
    expect(liveBytes).toHaveProperty(slowSlot);
    expect(Object.keys(idleSeconds)).toEqual(Object.keys(activity));
    expect(Object.keys(liveBytes)).toEqual(Object.keys(activity));
    expect(Object.values(activity)).not.toContain("waiting_for_input");

    writeFileSync(slowReleasePath, "", "utf-8");
  });
});
