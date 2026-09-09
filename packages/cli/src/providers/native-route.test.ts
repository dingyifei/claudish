// Protect native passthrough for bare Claude names before credential-filtered route():
// the MCP preflight tool (mcp-server.ts) and TUI route probe (tui/hooks/useRouteProbe.ts)
// need this guard, while explicit provider specs must retain their chosen provider.
import { describe, expect, test } from "bun:test";
import { claudeCodeTierAlias, normalizeNativeModelSpec } from "./claude-code-aliases.js";
import { nativeRouteFor } from "./native-route.js";

describe("nativeRouteFor", () => {
  test("slash-qualified ids are not native passthrough", () => {
    // Mirror proxy-server.ts:826: native requires !target.includes("/") && !hasExplicitProvider.
    expect(nativeRouteFor("anthropic/claude-opus-5")).toBeNull();
    expect(nativeRouteFor("anthropic/claude-sonnet-5")).toBeNull();
  });

  test("recognizes bare native names, normalizes tier aliases, and excludes other providers and explicit specs", () => {
    expect(nativeRouteFor("claude-opus-5")).toEqual({
      provider: "native-anthropic",
      modelSpec: "claude-opus-5",
      displayName: "Anthropic (Native)",
      isTierAlias: false,
    });
    expect(nativeRouteFor("claude-fable-5-1")).toEqual({
      provider: "native-anthropic",
      modelSpec: "claude-fable-5-1",
      displayName: "Anthropic (Native)",
      isTierAlias: false,
    });

    for (const alias of ["opus", "internal"]) {
      expect(nativeRouteFor(alias)).toEqual({
        provider: "native-anthropic",
        modelSpec: normalizeNativeModelSpec(alias),
        displayName: "Anthropic (Native)",
        isTierAlias: claudeCodeTierAlias(alias) !== null,
      });
    }

    expect(nativeRouteFor("grok-4.6")).toBeNull();
    expect(nativeRouteFor("kimi-k3")).toBeNull();
    expect(nativeRouteFor("anthropic@claude-opus-5")).toBeNull();
    expect(nativeRouteFor("dv@claude-opus-5-high")).toBeNull();
  });

  test("routes unrecognised bare names natively without treating them as tier aliases", () => {
    // The proxy routes typos natively too, so diagnostics must probe rather than declare success.
    expect(nativeRouteFor("some-typo-model")).toEqual({
      provider: "native-anthropic",
      modelSpec: "some-typo-model",
      displayName: "Anthropic (Native)",
      isTierAlias: false,
    });
  });
});
