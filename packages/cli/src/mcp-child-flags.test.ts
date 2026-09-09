import { describe, expect, test } from "bun:test";
import { buildChildClaudeFlags } from "./mcp-server.js";

describe("buildChildClaudeFlags", () => {
  test("no inputs yields no flags", () => {
    expect(buildChildClaudeFlags(undefined, undefined)).toBeUndefined();
    expect(buildChildClaudeFlags("", "")).toBeUndefined();
  });

  test("names the agent with the flag spelling the caller should not need to know", () => {
    // Verified against a live child: an unknown name makes Claude Code exit 1 with
    // "--agent 'x' not found. Available agents: …", so the flag is honored, not ignored.
    expect(buildChildClaudeFlags("dev:reviewer", undefined)).toEqual(["--agent", "dev:reviewer"]);
  });

  test("passes arbitrary Claude Code flags through untouched", () => {
    expect(buildChildClaudeFlags(undefined, "--effort high --permission-mode plan")).toEqual([
      "--effort",
      "high",
      "--permission-mode",
      "plan",
    ]);
  });

  test("combines the dedicated agent with other flags", () => {
    expect(buildChildClaudeFlags("dev:architect", "--effort high")).toEqual([
      "--agent",
      "dev:architect",
      "--effort",
      "high",
    ]);
  });

  test("the dedicated parameter wins over an --agent buried in claude_flags", () => {
    // Emitting both would hand Claude Code two --agent pairs and make the
    // effective agent depend on its argument precedence, which is not ours to
    // assume. Drop the flag AND its value.
    expect(buildChildClaudeFlags("dev:reviewer", "--agent dev:debugger --effort high")).toEqual([
      "--agent",
      "dev:reviewer",
      "--effort",
      "high",
    ]);
  });

  test("strips a conflicting --agent from the MIDDLE of the list, not just the front", () => {
    // A front-only implementation passes the test above. This one requires the
    // scan to cover every position.
    expect(
      buildChildClaudeFlags(
        "dev:reviewer",
        "--effort high --agent dev:debugger --permission-mode plan"
      )
    ).toEqual(["--agent", "dev:reviewer", "--effort", "high", "--permission-mode", "plan"]);
  });

  test("strips the --agent=value form too", () => {
    expect(buildChildClaudeFlags("dev:reviewer", "--effort high --agent=dev:debugger")).toEqual([
      "--agent",
      "dev:reviewer",
      "--effort",
      "high",
    ]);
  });

  test("strips every conflicting occurrence, not only the first", () => {
    expect(
      buildChildClaudeFlags("dev:reviewer", "--agent dev:debugger --effort high --agent dev:docs")
    ).toEqual(["--agent", "dev:reviewer", "--effort", "high"]);
  });

  test("a dangling --agent with no value drops only the flag", () => {
    expect(buildChildClaudeFlags("dev:reviewer", "--effort high --agent")).toEqual([
      "--agent",
      "dev:reviewer",
      "--effort",
      "high",
    ]);
  });

  test("does NOT strip --agents, which is a different flag", () => {
    // `--agents <json>` defines custom agents; it is unrelated to `--agent <name>`.
    // Stripping it would silently discard the caller's agent DEFINITIONS while
    // they believed they were passed.
    const json = '{"reviewer":{"description":"d","prompt":"p"}}';
    expect(buildChildClaudeFlags("dev:reviewer", `--agents ${json}`)).toEqual([
      "--agent",
      "dev:reviewer",
      "--agents",
      json,
    ]);
  });

  test("does not strip a conflicting --agent when no agent is named", () => {
    // Nothing to win the conflict, so the caller's flag stands.
    expect(buildChildClaudeFlags(undefined, "--effort high --agent dev:debugger")).toEqual([
      "--effort",
      "high",
      "--agent",
      "dev:debugger",
    ]);
  });

  test("leaves an --agent in claude_flags alone when no agent is named", () => {
    expect(buildChildClaudeFlags(undefined, "--agent dev:debugger")).toEqual([
      "--agent",
      "dev:debugger",
    ]);
  });

  test("splitting is whitespace-only — a value with spaces cannot be expressed", () => {
    // Pinned as a KNOWN LIMITATION, not an aspiration: the caller hands us one
    // string and we split it, so --append-system-prompt "two words" arrives as
    // three tokens. Documented on the parameter. If this ever needs to work it
    // needs a real tokenizer, and this test should change deliberately.
    expect(buildChildClaudeFlags(undefined, '--append-system-prompt "two words"')).toEqual([
      "--append-system-prompt",
      '"two',
      'words"',
    ]);
  });

  test("collapses runs of whitespace and ignores tabs/newlines", () => {
    expect(buildChildClaudeFlags(undefined, "  --effort\thigh \n --quiet ")).toEqual([
      "--effort",
      "high",
      "--quiet",
    ]);
  });

  test("trims an agent name rather than passing stray whitespace to Claude Code", () => {
    expect(buildChildClaudeFlags("  dev:reviewer  ", undefined)).toEqual([
      "--agent",
      "dev:reviewer",
    ]);
  });

  test("rejects an agent value that is really a flag", () => {
    expect(() => buildChildClaudeFlags("--dangerously-skip-permissions", undefined)).toThrow(
      /Expected a subagent name/
    );
  });
});
