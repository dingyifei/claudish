import { describe, expect, test } from "bun:test";
import { parseAdvisorAuth, resolveAdvisorAuth } from "./advisor-auth.js";
import { evaluateAdvisorStartup } from "./advisor-startup.js";
import {
  hasClaudeCodeLogin,
  resolveAdvisorToolEnv,
  shouldHideIncidentalAnthropicKey,
} from "./claude-runner.js";
import {
  type AdvisorSubscriptionReplay,
  advisorCredentialsFor,
  advisorRouteFor,
  runAdvisorCall,
} from "./handlers/native-handler-advisor.js";
import type { ClaudishConfig } from "./types.js";

const BEARER = "Bearer sk-ant-oat01-test-subscription-bearer-value";

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

/** The inbound request as the decorator sees it after the swap. */
function inboundRequest(): Record<string, unknown> {
  return {
    model: "claude-opus-5-5",
    stream: true,
    thinking: { type: "enabled", budget_tokens: 4000 },
    system: [
      { type: "text", text: "x-anthropic-billing-header: test" },
      { type: "text", text: "You are Claude Code." },
    ],
    tools: [
      { name: "advisor", description: "Consult an advisor.", input_schema: { type: "object" } },
    ],
    metadata: { user_id: "user-1" },
    messages: [
      { role: "user", content: "Refactor the parser." },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_adv", name: "advisor", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_adv",
            is_error: true,
            content: "<tool_use_error>Error: No such tool available: advisor</tool_use_error>",
          },
        ],
      },
    ],
  };
}

function replay(authorization: string | null = BEARER): AdvisorSubscriptionReplay {
  return {
    headers: {
      authorization: authorization ?? undefined,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20,advisor-tool-2026-03-01",
    },
    request: inboundRequest(),
  };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function capturingFetch(captured: Captured[], respond: () => Response): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return respond();
    },
    { preconnect(_url: string | URL): void {} }
  );
}

const anthropicAnswer = () =>
  new Response(JSON.stringify({ content: [{ type: "text", text: "Split the lexer first." }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("advisor auth mode", () => {
  test("parses the accepted spellings and rejects others", () => {
    expect(parseAdvisorAuth("subscription")).toBe("subscription");
    expect(parseAdvisorAuth(" OAuth ")).toBe("subscription");
    expect(parseAdvisorAuth("api-key")).toBe("api-key");
    expect(parseAdvisorAuth("metered")).toBeNull();
  });

  test("flag beats env; unset is api-key; a bad env value is reported", () => {
    expect(resolveAdvisorAuth(config(), {}).mode).toBe("api-key");
    expect(resolveAdvisorAuth(config(), { CLAUDISH_ADVISOR_AUTH: "subscription" }).mode).toBe(
      "subscription"
    );
    expect(
      resolveAdvisorAuth(config({ advisorAuth: "api-key" }), {
        CLAUDISH_ADVISOR_AUTH: "subscription",
      }).mode
    ).toBe("api-key");
    expect(resolveAdvisorAuth(config(), { CLAUDISH_ADVISOR_AUTH: "nope" })).toEqual({
      mode: "api-key",
      invalidEnvValue: "nope",
    });
  });
});

describe("subscription routing", () => {
  test("a Claude panel model goes to the Messages API only when subscription is on", () => {
    const metered = advisorRouteFor("claude-opus-5-5", "panel");
    expect(metered.kind).toBe("openrouter");
    expect(metered.subscription).toBeUndefined();

    const sub = advisorRouteFor("claude-opus-5-5", "panel", { subscription: true });
    expect(sub.kind).toBe("anthropic");
    expect(sub.host).toBe("api.anthropic.com");
    expect(sub.wireModel).toBe("claude-opus-5-5");
    expect(sub.subscription).toBe(true);
  });

  test("non-Claude panel models and the collector are unaffected", () => {
    const gemini = advisorRouteFor("google@gemini-4-argon", "panel", { subscription: true });
    expect(gemini.kind).toBe("google");
    expect(gemini.subscription).toBeUndefined();
    expect(
      advisorRouteFor("claude-haiku-5-5", "collector", { subscription: true }).subscription
    ).toBeUndefined();
  });

  test("a subscription panel route needs no resolved key", () => {
    expect([...advisorCredentialsFor(["claude-opus-5-5"], null, { subscription: true })]).toEqual(
      []
    );
    expect([
      ...advisorCredentialsFor(["claude-opus-5-5", "gemini-4-argon"], null, { subscription: true }),
    ]).toEqual(["google"]);
  });
});

describe("subscription replay request", () => {
  test("replays Claude Code's system, tools, metadata and auth headers onto the advisor model", async () => {
    const captured: Captured[] = [];
    const outcome = await runAdvisorCall({
      toolUseId: "toolu_adv",
      messages: inboundRequest().messages as any[],
      models: ["claude-opus-5-5"],
      collector: null,
      apiKeys: {},
      subscription: replay(),
      fetchImpl: capturingFetch(captured, anthropicAnswer),
      warn: () => {},
    });

    expect(outcome.result).toEqual({ text: "Split the lexer first.", isError: false });
    expect(captured).toHaveLength(1);
    const [req] = captured;
    expect(new URL(req.url).host).toBe("api.anthropic.com");
    expect(req.headers.authorization).toBe(BEARER);
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.headers["anthropic-beta"]).toBe("oauth-2025-04-20");

    const original = inboundRequest();
    expect(req.body.model).toBe("claude-opus-5-5");
    expect(req.body.system).toEqual(original.system);
    expect(req.body.tools).toEqual(original.tools);
    expect(req.body.metadata).toEqual(original.metadata);
    expect(req.body.tool_choice).toEqual({ type: "none" });
    expect(req.body.stream).toBe(false);
    expect(req.body.thinking).toBeUndefined();
    // The plumbing error is neutralised and the question is stated last.
    const last = req.body.messages.at(-1);
    expect(last.role).toBe("user");
    expect(JSON.stringify(req.body.messages)).not.toContain("No such tool available");
  });

  test("the bearer never reaches a non-Claude panel model", async () => {
    const captured: Captured[] = [];
    await runAdvisorCall({
      toolUseId: "toolu_adv",
      messages: inboundRequest().messages as any[],
      models: ["claude-opus-5-5", "openrouter@acme/model"],
      collector: null,
      apiKeys: { openrouter: "or-key-value" },
      subscription: replay(),
      fetchImpl: capturingFetch(captured, anthropicAnswer),
      warn: () => {},
    });
    const openrouter = captured.find((c) => new URL(c.url).host === "openrouter.ai");
    expect(openrouter).toBeDefined();
    expect(JSON.stringify(openrouter)).not.toContain("sk-ant-oat01");
  });

  test("a request without a usable bearer is refused, not sent", async () => {
    for (const authorization of [null, "Bearer placeholder-token-not-used-proxy"]) {
      const captured: Captured[] = [];
      const outcome = await runAdvisorCall({
        toolUseId: "toolu_adv",
        messages: inboundRequest().messages as any[],
        models: ["claude-opus-5-5"],
        collector: null,
        apiKeys: {},
        subscription: replay(authorization),
        fetchImpl: capturingFetch(captured, anthropicAnswer),
        warn: () => {},
      });
      expect(captured).toHaveLength(0);
      expect(outcome.result.isError).toBe(true);
      expect(outcome.panel[0].reason).toContain("--advisor-auth subscription");
    }
  });

  test("an Anthropic rejection becomes a sanitised failure without the bearer", async () => {
    const outcome = await runAdvisorCall({
      toolUseId: "toolu_adv",
      messages: inboundRequest().messages as any[],
      models: ["claude-opus-5-5"],
      collector: null,
      apiKeys: {},
      subscription: replay(),
      fetchImpl: capturingFetch([], () => new Response(`denied ${BEARER}`, { status: 403 })),
      warn: () => {},
    });
    expect(outcome.result.isError).toBe(true);
    expect(outcome.panel[0].reason).toContain("403");
    expect(outcome.result.text).not.toContain("sk-ant-oat01-test-subscription-bearer-value");
  });
});

describe("subscription startup", () => {
  const advisorConfig = (overrides: Partial<ClaudishConfig> = {}) =>
    config({
      advisor: true,
      advisorModels: ["claude-opus-5-5"],
      advisorCollector: null,
      advisorAuth: "subscription",
      ...overrides,
    });

  test("proceeds with a Claude Code login, names it, and warns", async () => {
    const cfg = advisorConfig();
    const decision = await evaluateAdvisorStartup(
      cfg,
      resolveAdvisorToolEnv(cfg, {}),
      {},
      {
        resolveCredentials: async (needed) => {
          expect([...needed]).toEqual([]);
          return {};
        },
        hasClaudeCodeLogin: () => true,
      }
    );
    expect(decision?.kind).toBe("proceed");
    const notice = decision?.kind === "proceed" ? decision.notice.join("\n") : "";
    expect(notice).toContain("your Claude Code login");
    expect(notice).toContain("consumer terms");
  });

  test("refuses without a Claude Code login", async () => {
    const cfg = advisorConfig();
    const decision = await evaluateAdvisorStartup(
      cfg,
      resolveAdvisorToolEnv(cfg, {}),
      {},
      {
        resolveCredentials: async () => ({}),
        hasClaudeCodeLogin: () => false,
      }
    );
    expect(decision?.kind).toBe("refuse");
    expect(decision?.kind === "refuse" ? decision.reason : "").toContain("Log in with `claude`");
  });

  test("refuses a malformed CLAUDISH_ADVISOR_AUTH", async () => {
    const cfg = advisorConfig({ advisorAuth: undefined });
    const decision = await evaluateAdvisorStartup(
      cfg,
      resolveAdvisorToolEnv(cfg, {}),
      { CLAUDISH_ADVISOR_AUTH: "metered" },
      { resolveCredentials: async () => ({}) }
    );
    expect(decision?.kind).toBe("refuse");
  });

  test("api-key mode is unchanged: the Claude panel model still needs OpenRouter", async () => {
    const cfg = advisorConfig({ advisorAuth: "api-key" });
    let asked: string[] = [];
    await evaluateAdvisorStartup(
      cfg,
      resolveAdvisorToolEnv(cfg, {}),
      {},
      {
        resolveCredentials: async (needed) => {
          asked = [...needed];
          return { openrouter: true };
        },
      }
    );
    expect(asked).toEqual(["openrouter"]);
  });
});

describe("subscription child auth", () => {
  const noFile = () => false;
  const noKeychain = () => false;

  test("hasClaudeCodeLogin counts a bearer login, not an API key", () => {
    expect(
      hasClaudeCodeLogin({
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-real" },
        fileExists: noFile,
        keychainProbe: noKeychain,
      })
    ).toBe(false);
    expect(hasClaudeCodeLogin({ env: {}, fileExists: () => true, keychainProbe: noKeychain })).toBe(
      true
    );
    expect(
      hasClaudeCodeLogin({
        env: { ANTHROPIC_AUTH_TOKEN: "placeholder-token-not-used-proxy-handles-auth" },
        fileExists: noFile,
        keychainProbe: noKeychain,
      })
    ).toBe(false);
  });

  test("an incidental ANTHROPIC_API_KEY is hidden so the child sends its bearer", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-api03-real" };
    const cfg = config({
      advisor: true,
      advisorModels: ["claude-opus-5-5"],
      model: "g@gemini-4-argon",
    });
    expect(shouldHideIncidentalAnthropicKey(cfg, env)).toBe(false);
    expect(shouldHideIncidentalAnthropicKey({ ...cfg, advisorAuth: "subscription" }, env)).toBe(
      true
    );
  });
});
