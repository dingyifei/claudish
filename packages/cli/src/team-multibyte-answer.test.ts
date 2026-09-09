import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runModels, setupSession } from "./team-orchestrator.js";

const ANSWER = "answer 🚀 日本語 end";

describe("team multibyte answer capture", () => {
  it("preserves UTF-8 split across separate child stdout chunks", async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), "team-multibyte-answer-"));
    const fakeDir = mkdtempSync(join(tmpdir(), "fake-claudish-multibyte-"));
    const fakeClaudish = join(fakeDir, "claudish");
    const originalClaudishBin = process.env.CLAUDISH_BIN;
    const originalCaptureMode = process.env.CLAUDISH_TEAM_CAPTURE;

    writeFileSync(
      fakeClaudish,
      `#!/usr/bin/env bun
for await (const chunk of process.stdin) {
  void chunk;
}

const answer = ${JSON.stringify(ANSWER)};
const line = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: answer }],
  },
}) + "\\n";
const bytes = Buffer.from(line, "utf8");
const emojiAt = bytes.indexOf(Buffer.from("🚀", "utf8"));
if (emojiAt === -1) {
  throw new Error("emoji missing from fake stream-json frame");
}

const splitAt = emojiAt + 2;
const writeStdout = (chunk) => new Promise((resolve, reject) => {
  process.stdout.write(chunk, (error) => error ? reject(error) : resolve());
});

await writeStdout(bytes.subarray(0, splitAt));
await Bun.sleep(50);
await writeStdout(bytes.subarray(splitAt));
`,
      "utf-8"
    );
    chmodSync(fakeClaudish, 0o755);

    try {
      process.env.CLAUDISH_BIN = fakeClaudish;
      delete process.env.CLAUDISH_TEAM_CAPTURE;
      setupSession(sessionPath, ["multibyte-model"], "Return the answer.");

      const status = await runModels(sessionPath, {
        captureMode: "stream-json",
        spawnPlanner: async () => ({ pinned: new Map<string, string>() }),
      });
      const [slotId, model] = Object.entries(status.models)[0];
      const response = readFileSync(join(sessionPath, `response-${slotId}.md`), "utf-8");

      expect(model.state).toBe("COMPLETED");
      expect(response).toContain("🚀");
      expect(response).toContain("日本語");
      expect(response).not.toContain("�");
      expect(response).toBe(`${ANSWER}\n`);
      expect(model.outputSize).toBe(Buffer.byteLength(`${ANSWER}\n`, "utf8"));
    } finally {
      if (originalClaudishBin === undefined) {
        delete process.env.CLAUDISH_BIN;
      } else {
        process.env.CLAUDISH_BIN = originalClaudishBin;
      }
      if (originalCaptureMode === undefined) {
        delete process.env.CLAUDISH_TEAM_CAPTURE;
      } else {
        process.env.CLAUDISH_TEAM_CAPTURE = originalCaptureMode;
      }
      rmSync(sessionPath, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });
});
