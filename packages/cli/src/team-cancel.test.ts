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
  teamSlotIdleSeconds,
} from "./team-orchestrator.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const spawnPlanner = async () => ({ pinned: new Map<string, string>() });

let tempRoot: string;
let fakeDir: string;
let fakeClaudish: string;
let originalClaudishBin: string | undefined;
let handles: TeamHandle[];

function makeSession(prefix: string, models: string[]): string {
  const sessionPath = mkdtempSync(join(tempRoot, prefix));
  setupSession(sessionPath, models, "Wait until the caller cancels this run.");
  return sessionPath;
}

async function startSlowTeam(sessionPath: string): Promise<TeamHandle> {
  const handle = await startModels(sessionPath, {
    captureMode: "stream-json",
    spawnPlanner,
  });
  handles.push(handle);
  return handle;
}

async function waitForSlotToStop(
  sessionPath: string,
  slotId: string,
  limitMs = 1_500
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
  tempRoot = mkdtempSync(join(tmpdir(), "team-cancel-test-"));
  fakeDir = mkdtempSync(join(tmpdir(), "fake-claudish-cancel-"));
  fakeClaudish = join(fakeDir, "claudish");
  originalClaudishBin = process.env.CLAUDISH_BIN;
  handles = [];

  writeFileSync(
    fakeClaudish,
    `#!/bin/sh
cat > /dev/null
sleep 2
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"uncancelled child completed"}]},"session_id":"fake-cancel-session"}'
exit 0
`,
    "utf-8"
  );
  chmodSync(fakeClaudish, 0o755);
  process.env.CLAUDISH_BIN = fakeClaudish;
});

afterEach(async () => {
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

describe("team run cancellation", () => {
  it("returns a live handle before children finish and removes liveness on settle", async () => {
    const sessionPath = makeSession("live-", ["slow-model"]);
    const handle = await startSlowTeam(sessionPath);
    const slotId = handle.slots["slow-model"];

    expect(slotId).toMatch(/^\d{2,}$/);
    expect(getStatus(sessionPath).models[slotId]?.state).toBe("RUNNING");
    const idle = teamSlotIdleSeconds(handle.teamSessionId);
    expect(idle).not.toBeNull();
    expect(typeof idle?.[slotId]).toBe("number");

    const cancelled = await cancelTeamRun(handle.teamSessionId);
    expect(cancelled).toEqual({ found: true, cancelled: [slotId] });
    await handle.done;
    expect(teamSlotIdleSeconds(handle.teamSessionId)).toBeNull();
  });

  it("cancels one slot while leaving the other slot running", async () => {
    const sessionPath = makeSession("one-slot-", ["slow-a", "slow-b"]);
    const handle = await startSlowTeam(sessionPath);
    const cancelledSlot = handle.slots["slow-a"];
    const survivingSlot = handle.slots["slow-b"];

    const result = await cancelTeamRun(handle.teamSessionId, cancelledSlot);
    expect(result).toEqual({ found: true, cancelled: [cancelledSlot] });

    const status = await waitForSlotToStop(sessionPath, cancelledSlot);
    expect(status.models[cancelledSlot]?.state).not.toBe("RUNNING");
    expect(status.models[cancelledSlot]?.error?.reason).toBe("cancelled");
    expect(status.models[survivingSlot]?.state).toBe("RUNNING");
    expect(typeof teamSlotIdleSeconds(handle.teamSessionId)?.[survivingSlot]).toBe("number");

    await cancelTeamRun(handle.teamSessionId, survivingSlot);
    await handle.done;
  });

  it("cancels every slot when no slot id is supplied", async () => {
    const sessionPath = makeSession("all-slots-", ["slow-a", "slow-b"]);
    const handle = await startSlowTeam(sessionPath);
    const expectedSlots = Object.values(handle.slots).sort();

    const result = await cancelTeamRun(handle.teamSessionId);
    expect(result.found).toBe(true);
    expect(result.cancelled.sort()).toEqual(expectedSlots);

    const settled = await handle.done;
    expect(Object.values(settled.models).every((model) => model.state !== "RUNNING")).toBe(true);
    for (const slotId of expectedSlots) {
      expect(settled.models[slotId]?.error?.reason).toBe("cancelled");
    }
    expect(teamSlotIdleSeconds(handle.teamSessionId)).toBeNull();
  });

  it("reports an unknown run without claiming any cancellation", async () => {
    await expect(cancelTeamRun("unknown-team-session")).resolves.toEqual({
      found: false,
      cancelled: [],
    });
  });
});
