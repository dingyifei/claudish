/**
 * Process-level coverage for SessionCreateOptions passthroughs.
 *
 * The shared fake child exposes selected spawn environment values without a
 * model or API key. Every manager writes into a per-test temporary root, and
 * afterEach shuts down any child that is still live.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ENV } from "../config.js";
import { SessionManager } from "./session-manager.js";
import type { SessionStatus } from "./types.js";

const FAKE_CLAUDISH_TS = join(
  dirname(fileURLToPath(import.meta.url)),
  "test-helpers",
  "fake-claudish.ts"
);
const TERMINAL_STATUSES: readonly SessionStatus[] = ["completed", "failed", "cancelled", "timeout"];

const originalClaudishBin = process.env.CLAUDISH_BIN;
let sessionsDir: string;
let managers: SessionManager[];

function makeManager(): SessionManager {
  const manager = new SessionManager({ sessionsDir, stallSeconds: 0 });
  managers.push(manager);
  return manager;
}

function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("waitUntil timed out"));
      setTimeout(check, 20);
    };
    check();
  });
}

async function waitForTerminal(manager: SessionManager, sessionId: string): Promise<void> {
  await waitUntil(() => TERMINAL_STATUSES.includes(manager.getSession(sessionId).status));
}

function readOutputJson(manager: SessionManager, sessionId: string): Record<string, string | null> {
  return JSON.parse(manager.getOutput(sessionId).output.trim()) as Record<string, string | null>;
}

beforeAll(() => {
  process.env.CLAUDISH_BIN = FAKE_CLAUDISH_TS;
});

afterAll(() => {
  if (originalClaudishBin === undefined) delete process.env.CLAUDISH_BIN;
  else process.env.CLAUDISH_BIN = originalClaudishBin;
});

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "session-create-options-"));
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.shutdownAll()));
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe("SessionCreateOptions passthroughs", () => {
  test("uses a caller-supplied sessionId verbatim", () => {
    const manager = makeManager();
    const sessionId = manager.createSession({
      model: "test-model",
      sessionId: "slot-07",
      claudishFlags: ["--sleep", "60"],
    });

    expect(sessionId).toBe("slot-07");
    expect(manager.getSession(sessionId).sessionId).toBe("slot-07");
  });

  test("rejects reuse of a live caller-supplied sessionId", () => {
    const manager = makeManager();
    const sessionId = "live-slot";
    manager.createSession({
      model: "first-model",
      sessionId,
      claudishFlags: ["--sleep", "60"],
    });
    const originalPid = manager.getSession(sessionId).pid;

    expect(() =>
      manager.createSession({
        model: "replacement-model",
        sessionId,
        claudishFlags: ["--sleep", "60"],
      })
    ).toThrow(`Session id already in use: ${sessionId}`);
    expect(manager.getSession(sessionId).model).toBe("first-model");
    expect(manager.getSession(sessionId).pid).toBe(originalPid);
  });

  test("writes artifacts to sessionDir instead of the manager sessionsDir", () => {
    const manager = makeManager();
    const sessionId = "custom-artifacts";
    const sessionDir = join(sessionsDir, "elsewhere", "slot-artifacts");
    const prompt = "keep this artifact in the requested directory";

    manager.createSession({
      model: "test-model",
      sessionId,
      sessionDir,
      prompt,
      claudishFlags: ["--sleep", "60"],
    });

    expect(readFileSync(join(sessionDir, "prompt.md"), "utf8")).toBe(prompt);
    expect(manager.getDiagnostics(sessionId).sessionDir).toBe(sessionDir);
    expect(existsSync(join(sessionsDir, sessionId))).toBe(false);
  });

  test("points the child token tracker at tokenFile", async () => {
    const manager = makeManager();
    const tokenFile = join(sessionsDir, "accounting", "slot-03.json");
    const sessionId = manager.createSession({
      model: "test-model",
      tokenFile,
      claudishFlags: ["--print-env", ENV.CLAUDISH_TOKEN_FILE],
    });

    await waitForTerminal(manager, sessionId);

    expect(readOutputJson(manager, sessionId)[ENV.CLAUDISH_TOKEN_FILE]).toBe(tokenFile);
  });

  test("passes keepUnrecognizedJson to the session reducer", async () => {
    const manager = makeManager();
    const sessionId = manager.createSession({
      model: "test-model",
      keepUnrecognizedJson: true,
      claudishFlags: ["--print-argv"],
    });

    await waitForTerminal(manager, sessionId);

    const [rawArgv] = manager.getOutput(sessionId).output.split("\n");
    const argv = JSON.parse(rawArgv) as string[];
    expect(argv).toContain("--print-argv");
  });

  test("omitting all four options preserves the random id and artifact, token, and reducer defaults", async () => {
    const manager = makeManager();
    const envSessionId = manager.createSession({
      model: "test-model",
      claudishFlags: ["--print-env", ENV.CLAUDISH_TOKEN_FILE],
    });

    await waitForTerminal(manager, envSessionId);

    const defaultSessionDir = join(sessionsDir, envSessionId);
    expect(envSessionId).toMatch(/^[0-9a-f]{8}$/);
    expect(manager.getDiagnostics(envSessionId).sessionDir).toBe(defaultSessionDir);
    expect(existsSync(defaultSessionDir)).toBe(true);
    expect(readOutputJson(manager, envSessionId)[ENV.CLAUDISH_TOKEN_FILE]).toBe(
      join(defaultSessionDir, "tokens.json")
    );

    const reducerSessionId = manager.createSession({
      model: "test-model",
      claudishFlags: ["--print-argv"],
    });
    await waitForTerminal(manager, reducerSessionId);

    // Valid JSON outside the stream-json vocabulary remains hidden by default.
    expect(manager.getOutput(reducerSessionId).output).not.toContain("--print-argv");
  });
});
