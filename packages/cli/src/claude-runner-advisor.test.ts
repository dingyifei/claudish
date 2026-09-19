import { describe, expect, it } from "bun:test";
import {
  ADVISOR_TOOL_ENV_VAR,
  isAdvisorNativeSession,
  resolveAdvisorToolEnv,
} from "./claude-runner.js";
import {
  CLAUDISH_PLACEHOLDER_API_KEY,
  CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
  isClaudishPlaceholderCredential,
  scrubInheritedClaudishPlaceholders,
} from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

function config(overrides: Partial<ClaudishConfig> = {}): ClaudishConfig {
  return {
    autoApprove: false,
    dangerous: false,
    interactive: false,
    debug: false,
    logLevel: "info",
    quiet: false,
    jsonOutput: false,
    monitor: false,
    stdin: false,
    claudeArgs: [],
    noLogs: false,
    diagMode: "auto",
    ...overrides,
  };
}

describe("isAdvisorNativeSession", () => {
  it("is true with advisor enabled and no model or model chain, regardless of monitor", () => {
    expect(isAdvisorNativeSession(config({ advisor: true, monitor: true }))).toBe(true);
    expect(isAdvisorNativeSession(config({ advisor: true, monitor: false }))).toBe(true);
  });

  it("is false when a Claude model is set", () => {
    expect(isAdvisorNativeSession(config({ advisor: true, model: "claude-sonnet-5" }))).toBe(false);
  });

  it("is false when a non-Claude model is set", () => {
    expect(isAdvisorNativeSession(config({ advisor: true, model: "grok-4.6" }))).toBe(false);
  });

  it("is false when a non-empty model chain is set", () => {
    expect(
      isAdvisorNativeSession(config({ advisor: true, modelChain: ["grok-4.6", "claude-sonnet-5"] }))
    ).toBe(false);
  });

  it("is false when advisor is false or absent, regardless of monitor and other settings", () => {
    expect(
      isAdvisorNativeSession(
        config({ advisor: false, monitor: true, model: "grok-4.6", modelChain: ["fallback"] })
      )
    ).toBe(false);
    expect(
      isAdvisorNativeSession(config({ advisor: false, monitor: false, model: "claude-sonnet-5" }))
    ).toBe(false);
    expect(isAdvisorNativeSession(config({ monitor: true, modelChain: ["fallback"] }))).toBe(false);
    expect(isAdvisorNativeSession(config({ monitor: false }))).toBe(false);
  });
});

describe("resolveAdvisorToolEnv", () => {
  it("sets the advisor variable to 1 when advisor is on and the parent variable is absent", () => {
    const result = resolveAdvisorToolEnv(config({ advisor: true }), {});

    expect(result.vars[ADVISOR_TOOL_ENV_VAR]).toBe("1");
    expect(result.source).toBe("claudish");
  });

  it("uses a value accepted by Claude Code's strict boolean parser", () => {
    const result = resolveAdvisorToolEnv(config({ advisor: true }), {});

    expect(["1", "true", "yes", "on"]).toContain(result.vars[ADVISOR_TOOL_ENV_VAR]);
  });

  it("preserves an inherited value of 0", () => {
    const parentEnv = { [ADVISOR_TOOL_ENV_VAR]: "0" };
    const result = resolveAdvisorToolEnv(config({ advisor: true }), parentEnv);

    expect(result.vars[ADVISOR_TOOL_ENV_VAR]).toBeUndefined();
    expect({ ...parentEnv, ...result.vars }[ADVISOR_TOOL_ENV_VAR]).toBe("0");
    expect(result.source).toBe("inherited");
  });

  it("preserves an inherited value of true", () => {
    const parentEnv = { [ADVISOR_TOOL_ENV_VAR]: "true" };
    const result = resolveAdvisorToolEnv(config({ advisor: true }), parentEnv);

    expect(result.vars[ADVISOR_TOOL_ENV_VAR]).toBeUndefined();
    expect({ ...parentEnv, ...result.vars }[ADVISOR_TOOL_ENV_VAR]).toBe("true");
    expect(result.source).toBe("inherited");
  });

  it("does not add the advisor variable when advisor is off", () => {
    const result = resolveAdvisorToolEnv(config({ advisor: false }), {});

    expect(result.vars[ADVISOR_TOOL_ENV_VAR]).toBeUndefined();
    expect(result.source).toBe("off");
  });

  it("exports the Claude Code advisor variable name", () => {
    expect(ADVISOR_TOOL_ENV_VAR).toBe("CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL");
  });
});

describe("claudish placeholder credential handling", () => {
  it("removes the exact auth-token placeholder and reports it", () => {
    const env = { ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN };

    const result = scrubInheritedClaudishPlaceholders(env);

    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.removed).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
  });

  it("removes the exact API-key placeholder and reports it", () => {
    const env = { ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY };

    const result = scrubInheritedClaudishPlaceholders(env);

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.removed).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("leaves real-looking Anthropic credentials untouched", () => {
    const env = {
      ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-abc",
      ANTHROPIC_API_KEY: "sk-ant-api03-xyz",
    };

    const result = scrubInheritedClaudishPlaceholders(env);

    expect(env).toEqual({
      ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-abc",
      ANTHROPIC_API_KEY: "sk-ant-api03-xyz",
    });
    expect(result.removed).toEqual([]);
  });

  it("leaves values that merely contain placeholder text untouched", () => {
    const env = {
      ANTHROPIC_AUTH_TOKEN: `prefix-${CLAUDISH_PLACEHOLDER_AUTH_TOKEN}`,
      ANTHROPIC_API_KEY: `${CLAUDISH_PLACEHOLDER_API_KEY}-suffix`,
    };

    const result = scrubInheritedClaudishPlaceholders(env);

    expect(env).toEqual({
      ANTHROPIC_AUTH_TOKEN: `prefix-${CLAUDISH_PLACEHOLDER_AUTH_TOKEN}`,
      ANTHROPIC_API_KEY: `${CLAUDISH_PLACEHOLDER_API_KEY}-suffix`,
    });
    expect(result.removed).toEqual([]);
  });

  it("leaves unrelated environment variables untouched", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/test/bin",
      HOME: "/test/home",
      FOO: "bar",
      ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN,
      ANTHROPIC_API_KEY: CLAUDISH_PLACEHOLDER_API_KEY,
    };

    const result = scrubInheritedClaudishPlaceholders(env);

    expect(env).toEqual({ PATH: "/test/bin", HOME: "/test/home", FOO: "bar" });
    expect(result.removed).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  });

  it("recognizes only the exact placeholder for the matching variable name", () => {
    expect(
      isClaudishPlaceholderCredential("ANTHROPIC_AUTH_TOKEN", CLAUDISH_PLACEHOLDER_AUTH_TOKEN)
    ).toBe(true);
    expect(isClaudishPlaceholderCredential("ANTHROPIC_API_KEY", CLAUDISH_PLACEHOLDER_API_KEY)).toBe(
      true
    );
    expect(
      isClaudishPlaceholderCredential("ANTHROPIC_AUTH_TOKEN", CLAUDISH_PLACEHOLDER_API_KEY)
    ).toBe(false);
    expect(
      isClaudishPlaceholderCredential("ANTHROPIC_API_KEY", CLAUDISH_PLACEHOLDER_AUTH_TOKEN)
    ).toBe(false);
    expect(isClaudishPlaceholderCredential("ANTHROPIC_AUTH_TOKEN", "sk-ant-oat01-abc")).toBe(false);
    expect(
      isClaudishPlaceholderCredential("ANTHROPIC_API_KEY", `${CLAUDISH_PLACEHOLDER_API_KEY}-suffix`)
    ).toBe(false);
    expect(
      isClaudishPlaceholderCredential("UNRELATED_VARIABLE", CLAUDISH_PLACEHOLDER_AUTH_TOKEN)
    ).toBe(false);
  });
});

describe("resolveAdvisorToolEnv gaps", () => {
  it("keeps the advisor variable absent when the advisor option and parent variable are absent", () => {
    const result = resolveAdvisorToolEnv(config(), {});

    expect(Object.keys(result.vars)).toEqual([]);
    expect(result.source).toBe("off");
  });

  it("returns no vars when the advisor variable is inherited", () => {
    const parentEnv = {
      [ADVISOR_TOOL_ENV_VAR]: "true",
      PATH: "/test/bin",
      HOME: "/test/home",
      FOO: "bar",
    };

    const result = resolveAdvisorToolEnv(config({ advisor: true }), parentEnv);

    expect(Object.keys(result.vars)).toEqual([]);
    expect(result.source).toBe("inherited");
  });
});
