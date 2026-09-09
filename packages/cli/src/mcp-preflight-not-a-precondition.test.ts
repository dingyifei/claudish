import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// MCP descriptions and result text are standing instructions in the calling agent's
// context, so preflight must stay a human-facing diagnostic rather than a prerequisite
// for team/create_session/run_prompt. defineTools is intentionally private and needs a
// live SessionManager, making a source-text guard the narrowest test for these literals.
const mcpServerSource = readFileSync(resolve(import.meta.dir, "mcp-server.ts"), "utf8");
const joinedStringLiterals = mcpServerSource.replace(/(["'`])\s*\+\s*(["'`])/g, "");

describe("MCP preflight guidance", () => {
  // This phrase spans a concatenation seam, so a broken join cannot silently pass the guards.
  test("joins string-concatenation seams so the directive guards remain effective", () => {
    expect(
      joinedStringLiterals.includes("serve each, whether that hop is subscription or metered"),
      "String-literal seam joining broke: update the seam-joining regex; the other assertions are now vacuous until it is fixed."
    ).toBe(true);
  });

  test("does not make preflight a spawn-tool precondition or route-discovery step", () => {
    expect(
      /Call this before `(?:team|create_session|run_prompt)`/i.test(joinedStringLiterals)
        ? "preflight tool description: found a directive to call preflight before a spawn tool"
        : null
    ).toBeNull();

    expect(
      joinedStringLiterals.includes("hop is subscription or metered; call `preflight` for that.")
        ? "search_models tool description: found a directive to call preflight to learn routing"
        : null
    ).toBeNull();

    expect(
      joinedStringLiterals.includes("To learn which provider would actually serve")
        ? "search_models result footer: found a directive to learn the provider route via preflight"
        : null
    ).toBeNull();

    expect(
      joinedStringLiterals.includes("or `preflight` to test a specific name against real routing")
        ? "search_models zero-results branch: found a directive to test routing via preflight"
        : null
    ).toBeNull();
  });
});
