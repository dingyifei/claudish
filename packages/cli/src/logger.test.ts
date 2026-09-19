import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
});

describe("logger filenames", () => {
  test("concurrent processes in the same second create distinct rotation-compatible paths", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "claudish-logger-test-"));
    const loggerUrl = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), "logger.ts")
    ).href;
    const fixedTime = Date.parse("2026-09-17T00:00:00.000Z");
    const childCode = `
      const NativeDate = Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) {
          if (args.length === 0) super(${fixedTime});
          else super(...args);
        }
        static now() { return ${fixedTime}; }
      };
      const { initLogger } = await import(${JSON.stringify(loggerUrl)});
      initLogger(true, "info", true);
      process.exit(0);
    `;

    const children = [
      Bun.spawn([process.execPath, "--eval", childCode], {
        cwd: tempDir,
        env: { ...process.env, HOME: tempDir },
        stdout: "pipe",
        stderr: "pipe",
      }),
      Bun.spawn([process.execPath, "--eval", childCode], {
        cwd: tempDir,
        env: { ...process.env, HOME: tempDir },
        stdout: "pipe",
        stderr: "pipe",
      }),
    ];
    const outcomes = await Promise.all(
      children.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
      }))
    );

    expect(outcomes).toEqual([
      { exitCode: 0, stderr: "" },
      { exitCode: 0, stderr: "" },
    ]);

    const logNames = readdirSync(join(tempDir, "logs")).sort();

    expect(logNames).toHaveLength(2);
    expect(logNames[0]).not.toBe(logNames[1]);
    expect(new Set(logNames.map((name) => name.replace(/_\d+\.log$/, ""))).size).toBe(1);
    for (const name of logNames) {
      expect(name.startsWith("claudish_")).toBe(true);
      expect(name.endsWith(".log")).toBe(true);
      expect(name).toMatch(/^claudish_2026-09-17_00-00-00_\d+\.log$/);
    }
  });
});
