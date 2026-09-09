import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { readTeamInputFile } from "./team-orchestrator.js";

describe("readTeamInputFile", () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(process.cwd(), ".team-input-file-test-"));
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("rejects an absolute path outside the current directory", () => {
    const inputPath = resolve(process.cwd(), "..", "outside-team-input.txt");

    expect(() => readTeamInputFile(inputPath)).toThrow(
      `Input file must be within current directory: ${inputPath}`
    );
  });

  test("rejects relative traversal outside the current directory", () => {
    const inputPath = "../../etc/passwd";

    expect(() => readTeamInputFile(inputPath)).toThrow(
      `Input file must be within current directory: ${inputPath}`
    );
  });

  test("reports the resolved path when the file is missing", () => {
    const inputPath = relative(process.cwd(), join(fixtureDir, "missing.md"));

    expect(() => readTeamInputFile(inputPath)).toThrow(
      `Input file not found: ${resolve(inputPath)}`
    );
  });

  test("rejects an empty file", () => {
    const inputPath = join(fixtureDir, "empty.md");
    writeFileSync(inputPath, "", "utf-8");

    expect(() => readTeamInputFile(inputPath)).toThrow(`Input file is empty: ${inputPath}`);
  });

  test("rejects a whitespace-only file", () => {
    const inputPath = join(fixtureDir, "whitespace.md");
    writeFileSync(inputPath, " \t\n\r\n", "utf-8");

    expect(() => readTeamInputFile(inputPath)).toThrow(`Input file is empty: ${inputPath}`);
  });

  test("returns UTF-8 contents verbatim, including trailing newlines", () => {
    const inputPath = join(fixtureDir, "prompt.md");
    const contents = "Review café ☕️\n第二行 🚀\n\n";
    writeFileSync(inputPath, contents, "utf-8");

    expect(readTeamInputFile(inputPath)).toBe(contents);
  });
});
