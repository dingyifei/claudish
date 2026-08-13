/**
 * Tests for the forced-claude.ai-auth hardening in claude-runner.ts.
 *
 * When a user's global (~/.claude/settings.json) or project (.claude/settings.json)
 * settings set `forceLoginMethod: "claudeai"`, Claude Code would block claudish's
 * proxy sessions (which authenticate via a placeholder ANTHROPIC_API_KEY) at startup.
 * claudish neutralizes this by writing `forceLoginMethod: "console"` into its own
 * --settings overlay, which loads at the CLI-args precedence tier — above the user,
 * project, and local settings files. Native-Anthropic / --monitor sessions use the
 * real claude.ai subscription, so they must be left untouched. The OS *managed* tier
 * cannot be overridden and is caught with a fail-fast abort instead.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudishSettingsOverlay,
  defaultKeychainAnthropicProbe,
  hasAnthropicApiKey,
  hasAnthropicOAuth,
  hasResolvableAnthropicAuth,
  isProxyAuthMode,
  mainLoopIsProxied,
  managedSettingsForcesClaudeAi,
  shouldHideIncidentalAnthropicKey,
} from "./claude-runner.js";
import { setConfigFileOverride } from "./profile-config.js";
import type { ClaudishConfig } from "./types.js";

const baseConfig = (overrides: Partial<ClaudishConfig> = {}): ClaudishConfig =>
  ({
    claudeArgs: [],
    ...overrides,
  }) as ClaudishConfig;

const statusLine = { type: "command", command: "echo hi", padding: 0 };

describe("isProxyAuthMode", () => {
  test("alternative model (proxy) → proxy mode", () => {
    expect(isProxyAuthMode(baseConfig({ model: "x-ai/grok-code-fast-1" }))).toBe(true);
  });

  test("bare/unknown model (proxy) → proxy mode", () => {
    expect(isProxyAuthMode(baseConfig({ model: "deepseek-v3" }))).toBe(true);
  });

  test("native claude model → NOT proxy mode", () => {
    expect(isProxyAuthMode(baseConfig({ model: "claude-opus-4-6" }))).toBe(false);
  });

  test("native claude in a profile mapping → NOT proxy mode", () => {
    expect(
      isProxyAuthMode(
        baseConfig({ modelOpus: "claude-opus-4-6", modelSonnet: "x-ai/grok-code-fast-1" })
      )
    ).toBe(false);
  });

  test("--monitor → NOT proxy mode (uses native subscription)", () => {
    expect(isProxyAuthMode(baseConfig({ monitor: true }))).toBe(false);
  });

  test("--monitor wins even with an alternative model set", () => {
    expect(isProxyAuthMode(baseConfig({ monitor: true, model: "x-ai/grok-code-fast-1" }))).toBe(
      false
    );
  });
});

describe("buildClaudishSettingsOverlay", () => {
  test("proxy mode injects forceLoginMethod: console", () => {
    const overlay = buildClaudishSettingsOverlay(statusLine, true);
    expect(overlay.forceLoginMethod).toBe("console");
    expect(overlay.disableClaudeAiConnectors).toBe(true);
    expect(overlay.statusLine).toBe(statusLine);
  });

  test("native/monitor mode OMITS forceLoginMethod entirely", () => {
    const overlay = buildClaudishSettingsOverlay(statusLine, false);
    expect("forceLoginMethod" in overlay).toBe(false);
    // Non-auth keys are still present regardless of mode.
    expect(overlay.disableClaudeAiConnectors).toBe(true);
    expect(overlay.statusLine).toBe(statusLine);
  });
});

describe("managedSettingsForcesClaudeAi", () => {
  test("managed settings forcing claudeai → true", () => {
    const readFile = (() => JSON.stringify({ forceLoginMethod: "claudeai" })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(true);
  });

  test("managed settings forcing console → false (not a claudeai block)", () => {
    const readFile = (() => JSON.stringify({ forceLoginMethod: "console" })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });

  test("managed settings without forceLoginMethod → false", () => {
    const readFile = (() => JSON.stringify({ someOtherKey: true })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });

  test("unreadable/garbled managed settings → false (best-effort, non-fatal)", () => {
    const readFile = (() => {
      throw new Error("EACCES");
    }) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });

  test("garbage JSON → false", () => {
    const readFile = (() => "{ not json") as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });
});

describe("hasResolvableAnthropicAuth", () => {
  // Inject all deps so tests are hermetic: never read the real process.env / filesystem,
  // never mutate process.platform, and never spawn `security`.
  const noEnv: NodeJS.ProcessEnv = {};
  const noFile = () => false;
  const noKeychain = () => false;

  test("ANTHROPIC_API_KEY env → true", () => {
    expect(
      hasResolvableAnthropicAuth({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fileExists: noFile,
        keychainProbe: noKeychain,
      })
    ).toBe(true);
  });

  test("ANTHROPIC_AUTH_TOKEN env → true", () => {
    expect(
      hasResolvableAnthropicAuth({
        env: { ANTHROPIC_AUTH_TOKEN: "tok-test" },
        fileExists: noFile,
        keychainProbe: noKeychain,
      })
    ).toBe(true);
  });

  test("credentials file present → true (no env, no keychain)", () => {
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: () => true, keychainProbe: noKeychain })
    ).toBe(true);
  });

  test("macOS Keychain item present → true (no env, no file)", () => {
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: noFile, keychainProbe: () => true })
    ).toBe(true);
  });

  test("Keychain absent + no env + no file → false", () => {
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: noFile, keychainProbe: noKeychain })
    ).toBe(false);
  });

  test("non-darwin (probe returns false) still resolves via env/file", () => {
    // Off-darwin, defaultKeychainAnthropicProbe returns false; the env/file checks
    // remain the only sources. All-absent → false; env present → still true.
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: noFile, keychainProbe: () => false })
    ).toBe(false);
    expect(
      hasResolvableAnthropicAuth({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fileExists: noFile,
        keychainProbe: () => false,
      })
    ).toBe(true);
  });
});

describe("shouldHideIncidentalAnthropicKey", () => {
  const apiKeyEnv: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-test" };
  const noEnv: NodeJS.ProcessEnv = {};
  const configPath = join(tmpdir(), `claudish-force-login-method-${randomUUID()}.json`);

  beforeAll(() => {
    writeFileSync(configPath, "{}", "utf8");
    setConfigFileOverride(configPath);
  });

  afterAll(() => {
    setConfigFileOverride(null);
    rmSync(configPath, { force: true });
  });

  test("native mapping + API key + default billing → true", () => {
    expect(
      shouldHideIncidentalAnthropicKey(baseConfig({ model: "claude-opus-4-6" }), apiKeyEnv)
    ).toBe(true);
  });

  test("native mapping + API key + API billing opt-in → false", () => {
    expect(
      shouldHideIncidentalAnthropicKey(
        baseConfig({ model: "claude-opus-4-6", anthropicApiBilling: true }),
        apiKeyEnv
      )
    ).toBe(false);
  });

  test("native mapping + no API key → false", () => {
    expect(shouldHideIncidentalAnthropicKey(baseConfig({ model: "claude-opus-4-6" }), noEnv)).toBe(
      false
    );
  });

  test("classifier-only passthrough + API key → false", () => {
    // Under classifier-only passthrough, the key may be the user's only Anthropic
    // credential; hiding it would strand the classifier request at a login gate.
    expect(
      shouldHideIncidentalAnthropicKey(
        baseConfig({ model: "x-ai/grok-code-fast-1", classifierProvider: "anthropic" }),
        apiKeyEnv
      )
    ).toBe(false);
  });

  test("no native mapping or classifier config + API key → false", () => {
    expect(
      shouldHideIncidentalAnthropicKey(baseConfig({ model: "x-ai/grok-code-fast-1" }), apiKeyEnv)
    ).toBe(false);
  });
});

describe("hasAnthropicOAuth / hasAnthropicApiKey — the split predicate", () => {
  const noKeychain = () => false;
  const noFile = () => false;

  test("a real API key is an API key, not OAuth", () => {
    const deps = {
      env: { ANTHROPIC_API_KEY: "sk-ant-real" },
      fileExists: noFile,
      keychainProbe: noKeychain,
    };
    expect(hasAnthropicApiKey(deps)).toBe(true);
    expect(hasAnthropicOAuth(deps)).toBe(false);
    expect(hasResolvableAnthropicAuth(deps)).toBe(true);
  });

  test("the credentials file and the Keychain both count as OAuth", () => {
    expect(hasAnthropicOAuth({ env: {}, fileExists: () => true, keychainProbe: noKeychain })).toBe(
      true
    );
    expect(hasAnthropicOAuth({ env: {}, fileExists: noFile, keychainProbe: () => true })).toBe(
      true
    );
  });

  test("ANTHROPIC_AUTH_TOKEN counts as OAuth — nothing bundles one incidentally", () => {
    expect(
      hasAnthropicOAuth({
        env: { ANTHROPIC_AUTH_TOKEN: "deliberate-token" },
        fileExists: noFile,
        keychainProbe: noKeychain,
      })
    ).toBe(true);
  });

  test("claudish's OWN placeholders are not credentials", () => {
    // The nested-claudish case: an inner session inherits the outer's env. Reading
    // the placeholder as a real credential makes the inner session preserve it and
    // forward it to api.anthropic.com, where it 401s.
    const deps = {
      env: {
        ANTHROPIC_API_KEY:
          "sk-ant-api03-placeholder-not-used-proxy-handles-auth-with-openrouter-key-xxxxxxxxxxxxxxxxxxxxx",
        ANTHROPIC_AUTH_TOKEN: "placeholder-token-not-used-proxy-handles-auth",
      },
      fileExists: noFile,
      keychainProbe: noKeychain,
    };
    expect(hasAnthropicApiKey(deps)).toBe(false);
    expect(hasAnthropicOAuth(deps)).toBe(false);
    expect(hasResolvableAnthropicAuth(deps)).toBe(false);
  });

  test("hasResolvableAnthropicAuth stays the disjunction of the two", () => {
    for (const [file, keychain, key] of [
      [false, false, false],
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ] as const) {
      const deps = {
        env: key ? { ANTHROPIC_API_KEY: "sk-ant-real" } : {},
        fileExists: () => file,
        keychainProbe: () => keychain,
      };
      expect(hasResolvableAnthropicAuth(deps)).toBe(
        hasAnthropicOAuth(deps) || hasAnthropicApiKey(deps)
      );
    }
  });
});

describe("defaultKeychainAnthropicProbe — the real probe", () => {
  test("never requests the secret: no -w in the argv it would run", () => {
    // The suite injects a fake probe everywhere else, so nothing else exercises
    // the real one. What matters most about it is a negative: `security
    // find-generic-password` WITHOUT `-w` checks that the item exists without
    // reading the token or raising a Keychain prompt.
    const source = defaultKeychainAnthropicProbe.toString();
    expect(source).toContain("find-generic-password");
    expect(source).toContain("Claude Code-credentials");
    expect(source).not.toContain('"-w"');
    expect(source).not.toContain("'-w'");
  });

  test("returns false off darwin without spawning anything", () => {
    if (process.platform === "darwin") return; // covered by the argv assertion above
    expect(defaultKeychainAnthropicProbe()).toBe(false);
  });
});

describe("isProxyAuthMode with classifier passthrough", () => {
  test("passthrough + resolvable creds → NOT proxy mode (real auth preserved)", () => {
    // No native role mapping at all — pure Codex. The passthrough is what flips
    // this out of proxy mode, and no test covered that combination before.
    const config = {
      modelOpus: "cx@gpt-5.6-sol",
      classifierProvider: "anthropic",
    } as unknown as Parameters<typeof isProxyAuthMode>[0];
    const hadCreds = hasResolvableAnthropicAuth();
    expect(isProxyAuthMode(config)).toBe(!hadCreds);
  });

  test("passthrough explicitly disabled → proxy mode, whatever creds exist", () => {
    const config = {
      modelOpus: "cx@gpt-5.6-sol",
      classifierProvider: "anthropic",
      classifierPassthrough: false,
    } as unknown as Parameters<typeof isProxyAuthMode>[0];
    expect(isProxyAuthMode(config)).toBe(true);
  });
});

describe("mainLoopIsProxied — auto-compaction gating", () => {
  const cfg = (o: Record<string, unknown>) => o as unknown as Parameters<typeof isProxyAuthMode>[0];

  test("pure Codex + classifier passthrough STILL gets the context-window clamp", () => {
    // The regression this pins: the clamp used to live inside the auth branch,
    // so enabling the passthrough flipped a proxied Codex session onto the
    // "native" path and silently dropped CLAUDE_CODE_AUTO_COMPACT_WINDOW — on
    // exactly the backend (gpt-5.6-sol, capped well below its advertised spec)
    // the clamp was written for.
    const config = cfg({ modelOpus: "cx@gpt-5.6-sol", classifierProvider: "anthropic" });
    expect(mainLoopIsProxied(config)).toBe(true);
    // The auth decision goes the OTHER way for this same config when credentials
    // resolve — which is the divergence that made the old shared branch wrong.
    if (hasResolvableAnthropicAuth()) {
      expect(isProxyAuthMode(config)).toBe(false);
      expect(mainLoopIsProxied(config)).toBe(true);
    }
  });

  test("a native Claude mapping does NOT get the clamp — Anthropic enforces its own window", () => {
    expect(mainLoopIsProxied(cfg({ modelSonnet: "claude-sonnet-5" }))).toBe(false);
  });

  test("gating does not change when the passthrough is toggled", () => {
    const base = { modelOpus: "cx@gpt-5.6-sol" };
    expect(mainLoopIsProxied(cfg(base))).toBe(
      mainLoopIsProxied(cfg({ ...base, classifierProvider: "anthropic" }))
    );
  });
});
