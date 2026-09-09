import { describe, expect, test } from "bun:test";
import {
  assertAgentAvailable,
  clearAgentCache,
  discoverAvailableAgents,
  parseAvailableAgents,
  seedAgentCacheForTest,
} from "./agent-availability.js";

describe("parseAvailableAgents", () => {
  test("extracts the roster from Claude Code's rejection message", () => {
    // Real message shape, measured 2026-08-22.
    const msg =
      "--agent 'zzz-bogus' not found. Available agents: claude, code-analysis:detective, " +
      "dev:architect, dev:reviewer, Explore, general-purpose";
    expect(parseAvailableAgents(msg)).toEqual([
      "claude",
      "code-analysis:detective",
      "dev:architect",
      "dev:reviewer",
      "Explore",
      "general-purpose",
    ]);
  });

  test("returns null when the roster is absent", () => {
    expect(parseAvailableAgents("some unrelated output")).toBeNull();
    expect(parseAvailableAgents("")).toBeNull();
  });

  test("returns null rather than an empty roster", () => {
    // An empty list must not be cached as "no agents exist", which would reject
    // every name. Null means "could not determine" and fails open.
    expect(parseAvailableAgents("Available agents:   ")).toBeNull();
  });
});

describe("assertAgentAvailable — with a known roster", () => {
  const CWD = "/seeded/project";

  test("accepts a name that is on the roster", async () => {
    clearAgentCache();
    seedAgentCacheForTest(CWD, ["dev:reviewer", "dev:architect", "general-purpose"]);
    await assertAgentAvailable("dev:reviewer", CWD);
  });

  test("REJECTS a typo, naming the valid agents", async () => {
    // The behaviour this module exists for. Claude Code silently ignores an
    // unknown --agent under --input-format stream-json and runs the DEFAULT
    // agent, so a typo would otherwise produce a plausible answer from the
    // wrong agent with nothing saying so.
    clearAgentCache();
    seedAgentCacheForTest(CWD, ["dev:reviewer", "dev:architect"]);
    await expect(assertAgentAvailable("dev:reviwer", CWD)).rejects.toThrow(
      /Unknown agent 'dev:reviwer'/
    );
    await expect(assertAgentAvailable("dev:reviwer", CWD)).rejects.toThrow(/dev:architect/);
  });

  test("is case- and whitespace-exact — no silent coercion", async () => {
    // Claude Code matches the name exactly; accepting "DEV:REVIEWER" here would
    // pass validation and then be ignored downstream, recreating the trap.
    clearAgentCache();
    seedAgentCacheForTest(CWD, ["dev:reviewer"]);
    await expect(assertAgentAvailable("DEV:REVIEWER", CWD)).rejects.toThrow(/Unknown agent/);
    await expect(assertAgentAvailable(" dev:reviewer ", CWD)).rejects.toThrow(/Unknown agent/);
  });

  test("rosters are isolated per cwd", async () => {
    // Measured: this repo resolves 24 agents, /tmp resolves 5. A global cache
    // would reject an agent that is valid in the directory the child runs in.
    clearAgentCache();
    seedAgentCacheForTest("/project/a", ["dev:reviewer"]);
    seedAgentCacheForTest("/project/b", ["general-purpose"]);
    await assertAgentAvailable("dev:reviewer", "/project/a");
    await expect(assertAgentAvailable("dev:reviewer", "/project/b")).rejects.toThrow(
      /Unknown agent/
    );
  });

  test("a seeded roster is served from cache, not re-probed", async () => {
    // The seeded cwd does not exist, so a probe would fail open and accept
    // anything. Rejection proves the cached roster was used.
    clearAgentCache();
    seedAgentCacheForTest("/nonexistent-cached-dir", ["only-this-one"]);
    await expect(assertAgentAvailable("something-else", "/nonexistent-cached-dir")).rejects.toThrow(
      /Unknown agent/
    );
    expect((await discoverAvailableAgents("/nonexistent-cached-dir"))?.has("only-this-one")).toBe(
      true
    );
  });
});

describe("assertAgentAvailable — degenerate inputs", () => {
  test("no agent named is a no-op and never probes", async () => {
    clearAgentCache();
    await assertAgentAvailable(undefined, "/nonexistent-dir-for-test");
    await assertAgentAvailable("", "/nonexistent-dir-for-test");
  });

  test("fails OPEN when the roster cannot be determined", async () => {
    // Spawning in a directory that does not exist makes the probe error.
    // Blocking every session because a probe broke would be worse than the trap
    // this guards, so an undeterminable roster must not throw.
    clearAgentCache();
    await assertAgentAvailable("whatever-agent", "/nonexistent-dir-for-test-xyz");
  });
});
