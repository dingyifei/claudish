import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModels, setupSession } from "./team-orchestrator.js";

const ANSWER = "The long-running tool call finished and the answer survived intact.";

describe("team slot heartbeat survival", () => {
  it("keeps a working slot alive through a scaled-down silent tool-call interval", async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), "team-heartbeat-survival-"));
    const fakeDir = mkdtempSync(join(tmpdir(), "fake-claudish-heartbeat-"));
    const fakeClaudish = join(fakeDir, "claudish");
    const originalClaudishBin = process.env.CLAUDISH_BIN;

    const heartbeatOne = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "toolu_fake_long_call",
      tool_name: "Bash",
      elapsed_time_seconds: 0.025,
      heartbeat: true,
      session_id: "fake-heartbeat-session",
    });
    const heartbeatTwo = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "toolu_fake_long_call",
      tool_name: "Bash",
      elapsed_time_seconds: 0.05,
      heartbeat: true,
      session_id: "fake-heartbeat-session",
    });
    const assistantMessage = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: ANSWER }],
      },
      session_id: "fake-heartbeat-session",
    });

    writeFileSync(
      fakeClaudish,
      `#!/bin/sh
cat > /dev/null
printf '%s\n' '${heartbeatOne}'
sleep 0.025
printf '%s\n' '${heartbeatTwo}'
# Scaled-down analogue of the old 90-second apparent-silence window.
sleep 0.250
printf '%s\n' '${assistantMessage}'
exit 0
`,
      "utf-8"
    );
    chmodSync(fakeClaudish, 0o755);

    try {
      process.env.CLAUDISH_BIN = fakeClaudish;
      setupSession(sessionPath, ["heartbeat-model"], "Run the long tool call.");

      const startedAt = Date.now();
      const status = await runModels(sessionPath, {
        captureMode: "stream-json",
        minOutputBytes: 0,
        spawnPlanner: async () => ({ pinned: new Map<string, string>() }),
      });
      const elapsedMs = Date.now() - startedAt;
      const [slotId, model] = Object.entries(status.models)[0];
      const response = readFileSync(join(sessionPath, `response-${slotId}.md`), "utf-8");

      expect(elapsedMs).toBeGreaterThanOrEqual(200);
      expect(model.state).toBe("COMPLETED");
      expect(model.state).not.toBe("TIMEOUT");
      expect(model.exitCode).toBe(0);
      expect(model.error).toBeUndefined();
      expect(response).toContain(ANSWER);
      expect(response.split(ANSWER)).toHaveLength(2);
    } finally {
      if (originalClaudishBin === undefined) {
        delete process.env.CLAUDISH_BIN;
      } else {
        process.env.CLAUDISH_BIN = originalClaudishBin;
      }
      rmSync(sessionPath, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });
});
