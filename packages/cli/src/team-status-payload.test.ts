import { describe, expect, test } from "bun:test";
import { buildTeamStatusPayload, teamStatusNote } from "./mcp-server.js";
import type { ModelStatus, TeamStatus } from "./team-orchestrator.js";

function slot(state: ModelStatus["state"], outputSize: number): ModelStatus {
  return {
    state,
    exitCode: state === "COMPLETED" ? 0 : null,
    startedAt: "2026-09-09T00:00:00.000Z",
    completedAt: state === "COMPLETED" ? "2026-09-09T00:22:00.000Z" : null,
    outputSize,
  };
}

describe("teamStatusNote", () => {
  test("omits the note for settled runs regardless of liveness", () => {
    expect(teamStatusNote({ anyRunning: false, live: false })).toBeUndefined();
    expect(teamStatusNote({ anyRunning: false, live: true })).toBeUndefined();
  });

  test("names outputSize and all three live fields for running live slots", () => {
    const note = teamStatusNote({ anyRunning: true, live: true });

    expect(typeof note).toBe("string");
    expect(note).toContain("outputSize");
    expect(note).toContain("live_output_bytes_by_slot");
    expect(note).toContain("idle_seconds_by_slot");
    expect(note).toContain("activity_by_slot");
  });

  test("puts the outputSize trap before the live-field remedy", () => {
    const note = teamStatusNote({ anyRunning: true, live: true }) ?? "";
    const trapIndex = note.indexOf("outputSize");
    const remedyIndex = note.indexOf("live_output_bytes_by_slot");

    // A missing warning has index -1, which would otherwise pass the ordering check.
    expect(trapIndex).toBeGreaterThanOrEqual(0);
    expect(remedyIndex).toBeGreaterThanOrEqual(0);
    expect(trapIndex).toBeLessThan(remedyIndex);
  });

  test("warns about outputSize without naming unavailable live fields", () => {
    const note = teamStatusNote({ anyRunning: true, live: false });

    expect(note).toContain("outputSize");
    expect(note).not.toContain("live_output_bytes_by_slot");
    expect(note).not.toContain("idle_seconds_by_slot");
    expect(note).not.toContain("activity_by_slot");
  });
});

describe("buildTeamStatusPayload", () => {
  test("carries live bytes without rewriting outputSize and includes a note, not a summary", () => {
    const status: TeamStatus = {
      startedAt: "2026-09-09T00:00:00.000Z",
      models: { "01": slot("RUNNING", 0), "02": slot("COMPLETED", 31112) },
    };
    const payload = buildTeamStatusPayload({
      status,
      sessionPath: "/tmp/team-status-payload-test",
      idle: { "01": 2 },
      activity: { "01": "running" },
      liveBytes: { "01": 18342 },
    });

    expect(payload.live_output_bytes_by_slot).toEqual({ "01": 18342 });
    expect((payload.models as TeamStatus["models"])["01"].outputSize).toBe(0);
    expect(status.models["01"].outputSize).toBe(0);
    expect(payload).toHaveProperty("note");
    expect(payload.note).toContain("outputSize");
    expect(payload).not.toHaveProperty("summary");
  });

  test("includes a summary and no note when every slot is completed", () => {
    const status: TeamStatus = {
      startedAt: "2026-09-09T00:00:00.000Z",
      models: { "01": slot("COMPLETED", 18342), "02": slot("COMPLETED", 31112) },
    };
    const payload = buildTeamStatusPayload({
      status,
      sessionPath: "/tmp/team-status-payload-test",
      idle: null,
      activity: null,
      liveBytes: null,
    });

    expect(payload).toHaveProperty("summary");
    expect(typeof payload.summary).toBe("string");
    expect(payload).not.toHaveProperty("note");
  });

  test("keeps the note for an orphaned running slot with null liveness fields", () => {
    const status: TeamStatus = {
      startedAt: "2026-09-09T00:00:00.000Z",
      models: { "01": slot("RUNNING", 0) },
    };
    const payload = buildTeamStatusPayload({
      status,
      sessionPath: "/tmp/team-status-payload-test",
      idle: null,
      activity: null,
      liveBytes: null,
    });

    expect(payload).toHaveProperty("note");
    expect(payload.note).toContain("outputSize");
    expect(payload.live_output_bytes_by_slot).toBeNull();
    expect(payload.idle_seconds_by_slot).toBeNull();
    expect(payload.activity_by_slot).toBeNull();
  });
});
