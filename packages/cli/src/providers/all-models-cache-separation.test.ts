import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ALL_MODELS_CACHE_PATH } from "./all-models-cache.js";

const sourceRoot = resolve(import.meta.dir, "..");
const mcpServerPath = resolve(sourceRoot, "mcp-server.ts");

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") files.push(...sourceFiles(path));
    } else if (entry.isFile() && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("catalog cache file separation", () => {
  // Mutation targets: all-models-cache.ts:102 and mcp-server.ts:93. Restoring
  // either writer to the retired filename makes these path/source guards fail.
  test("the cloud models catalog uses its v3-specific cache file", () => {
    expect(
      ALL_MODELS_CACHE_PATH.endsWith(`${sep}.claudish${sep}cloud-models-catalog-v3.json`)
    ).toBe(true);
  });

  test("production source does not assign or join the retired cache filename", () => {
    const retiredLiteral = /["']all-models\.json["']/;
    const pathConstruction = /\b(?:join|resolve)\s*\(|=/;
    const offenders: string[] = [];

    for (const file of sourceFiles(sourceRoot)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (retiredLiteral.test(line) && pathConstruction.test(line)) {
          offenders.push(`${relative(sourceRoot, file)}:${index + 1}`);
        }
      }
    }

    expect(offenders, `retired cache path writers:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("the MCP OpenRouter list uses its own cache file without importing the server", () => {
    const source = readFileSync(mcpServerPath, "utf-8");
    expect(source).toMatch(
      /OPENROUTER_MODELS_CACHE_PATH\s*=\s*join\([^\n)]*["']openrouter-models\.json["']\)/
    );
  });
});
