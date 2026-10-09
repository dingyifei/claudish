import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeChainFrom } from "../probe/probe-chain.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import { NATIVE_NOT_PROBED } from "../providers/native-route.js";
import type { RouteTier } from "../providers/provider-definitions.js";
import {
  type RouteExplanation,
  TIER_LABEL,
  describeRouteExplanation,
  hopLabel,
} from "../providers/routing-rules.js";
import { paneRouteLine } from "../team-grid.js";
import {
  resolveFallbackHop,
  routingHeaderLines,
  hopLabel as tuiHopLabel,
} from "./components/RoutingContent.js";
import { probeQueue, probeRowsFrom } from "./hooks/useRouteProbe.js";

const CATALOG_FIXTURE = join(
  import.meta.dir,
  "..",
  "test-fixtures",
  "stage5-explain-route-catalog.json"
);

function headerText(input: Parameters<typeof routingHeaderLines>[0]): string[] {
  return routingHeaderLines(input).map((line) => line.map((segment) => segment.text).join(""));
}

function config(defaultProvider?: string): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    ...(defaultProvider !== undefined ? { defaultProvider } : {}),
  };
}

function scopedProbeViews(): Array<{
  model: string;
  line: string;
  providers: string[];
}> {
  const home = mkdtempSync(join(tmpdir(), "claudish-stage7-probe-"));
  const configDir = join(home, ".claudish");
  const projectDir = join(home, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  copyFileSync(CATALOG_FIXTURE, join(configDir, "cloud-models-catalog-v3.json"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      routing: { "glm-*": ["openrouter"] },
    }),
    "utf8"
  );
  writeFileSync(
    join(projectDir, ".claudish.json"),
    JSON.stringify({ routing: { "glm-5*": ["openai"] } }),
    "utf8"
  );

  const routingUrl = new URL("../providers/routing-rules.ts", import.meta.url).href;
  const probeUrl = new URL("./hooks/useRouteProbe.ts", import.meta.url).href;
  const script = `
    const { explainRoute } = await import(${JSON.stringify(routingUrl)});
    const { probeRowsFrom } = await import(${JSON.stringify(probeUrl)});
    const values = [];
    for (const model of ["glm-5.3", "glm-4.6"]) {
      const view = probeRowsFrom(await explainRoute(model));
      values.push({
        model,
        line: view.summary.line,
        providers: view.rows.map((row) => row.provider),
      });
    }
    process.stdout.write(JSON.stringify(values));
  `;

  try {
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: projectDir,
      env: {
        HOME: home,
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        OPENAI_API_KEY: "stage7-openai",
        OPENROUTER_API_KEY: "stage7-openrouter",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    expect(child.exitCode, stderr || stdout).toBe(0);
    return JSON.parse(stdout) as ReturnType<typeof scopedProbeViews>;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("probeRowsFrom", () => {
  test("uses the project rule and the longest matching glob in its reason", () => {
    expect(scopedProbeViews()).toEqual([
      {
        model: "glm-5.3",
        line: 'user rule "glm-5*" (project)',
        providers: ["openai"],
      },
      {
        model: "glm-4.6",
        line: 'user rule "glm-*" (global)',
        providers: ["openrouter"],
      },
    ]);
  });

  test("queues kept rows once and never changes dropped rows to testing or no_key", () => {
    const dashscopeKey = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    const explanation: RouteExplanation = {
      requestedModel: "mixed-model",
      routedModel: "mixed-model",
      source: "user-rule",
      matchedPattern: "mixed-*",
      ruleScope: "project",
      candidates: [
        {
          provider: "qwen-payg",
          displayName: "Alibaba PAYG",
          modelSpec: "qpay@mixed-model",
          wireId: "mixed-model",
          position: "candidate",
          tier: "native",
          outcome: "kept",
        },
        {
          provider: "openrouter",
          displayName: "OpenRouter",
          modelSpec: "openrouter@mixed-model",
          wireId: "mixed-model",
          position: "fallback",
          tier: "gateway",
          outcome: "no-credential",
        },
      ],
      outcome: { kind: "ok" },
      warnings: [],
    };

    try {
      const view = probeRowsFrom(explanation);

      expect(view.rows.map((row) => [row.provider, row.status, row.outcome])).toEqual([
        ["qwen-payg", "pending", undefined],
        ["openrouter", "dropped", "no-credential"],
      ]);
      expect(probeQueue(view.rows)).toEqual([
        { index: 0, provider: "qwen-payg", modelSpec: "qpay@mixed-model" },
      ]);
      expect(view.rows.some((row) => row.status === "testing" || row.status === "no_key")).toBe(
        false
      );
    } finally {
      if (dashscopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = dashscopeKey;
    }
  });

  test("uses the shared native-auth not-probed note", () => {
    const view = probeRowsFrom({
      requestedModel: "claude-opus-5",
      routedModel: "claude-opus-5",
      source: "native",
      candidates: [],
      outcome: { kind: "ok" },
      warnings: [],
      native: {
        provider: "native-anthropic",
        modelSpec: "claude-opus-5",
        displayName: "Anthropic (Native)",
        isTierAlias: false,
      },
    });

    expect(view.summary.notes).toEqual([NATIVE_NOT_PROBED]);
    expect(view.rows).toEqual([
      expect.objectContaining({ provider: "native-anthropic", status: "unverified" }),
    ]);
  });
});

describe("route hop labels", () => {
  test("TIER_LABEL is total over RouteTier", () => {
    const expected = {
      subscription: "subscription",
      "dynamic-subscription": "subscription · account decides models",
      native: "native API",
      gateway: "gateway",
      fallback: "fallback",
    } satisfies Record<RouteTier, string>;

    expect(TIER_LABEL).toEqual(expected);
  });

  test("the shared, probe, and TUI labels agree for every tier and position", () => {
    const tiers: RouteTier[] = [
      "subscription",
      "dynamic-subscription",
      "native",
      "gateway",
      "fallback",
    ];

    for (const tier of tiers) {
      for (const position of ["candidate", "fallback"] as const) {
        const expected = hopLabel({ tier, position });
        const explanation: RouteExplanation = {
          requestedModel: "label-model",
          routedModel: "label-model",
          source: "catalog",
          catalog: "found",
          candidates: [
            {
              provider: "label-provider",
              displayName: "Label Provider",
              modelSpec: "label-provider@label-model",
              wireId: "label-model",
              tier,
              position,
              outcome: "kept",
            },
          ],
          outcome: { kind: "ok" },
          warnings: [],
        };
        const { chain } = probeChainFrom(explanation, {
          hintFor: () => undefined,
          provenanceFor: () => undefined,
        });

        expect(chain[0]?.label).toBe(expected);
        expect(tuiHopLabel({ status: "pending", tier, position })).toBe(expected);
      }
    }
  });
});

describe("routing header", () => {
  test("a project * rule wins and replaces the fallback header", () => {
    const lines = headerText({
      globalRules: { "*": ["openrouter"] },
      localRules: { "*": ["openai"] },
      resolved: { provider: "poe", source: "config-file" },
    });

    expect(lines.join("\n")).toContain("decides every model no other rule matches");
    expect(lines).toContain("  → openai (project)");
    expect(lines.some((line) => line.includes("Fallback hop:"))).toBe(false);
  });

  test("shows the resolved env, config, and default fallback states", () => {
    const envDisabled = headerText({
      globalRules: {},
      localRules: {},
      resolved: resolveFallbackHop(config("poe"), { CLAUDISH_DEFAULT_PROVIDER: "" }),
    }).join("\n");
    const configured = headerText({
      globalRules: {},
      localRules: {},
      resolved: resolveFallbackHop(config("poe"), {}),
    }).join("\n");
    const defaulted = headerText({
      globalRules: {},
      localRules: {},
      resolved: resolveFallbackHop(config(), {}),
    }).join("\n");

    expect(envDisabled).toContain('disabled, set to "" (CLAUDISH_DEFAULT_PROVIDER)');
    expect(configured).toContain("→ poe (config)");
    expect(defaulted).toContain("→ openrouter (default)");
  });
});

test("the team pane route line shows the calculated catalog chain", () => {
  const explanation: RouteExplanation = {
    requestedModel: "catalog-model",
    routedModel: "catalog-model",
    source: "catalog",
    catalog: "found",
    candidates: [
      {
        provider: "kimi-coding",
        displayName: "Kimi Coding",
        modelSpec: "kc@catalog-model",
        wireId: "catalog-model",
        position: "candidate",
        tier: "subscription",
        outcome: "kept",
      },
      {
        provider: "openrouter",
        displayName: "OpenRouter",
        modelSpec: "openrouter@catalog-model",
        wireId: "catalog-model",
        position: "candidate",
        tier: "gateway",
        outcome: "kept",
      },
    ],
    fallbackWithheld: "already-gathered",
    outcome: { kind: "ok" },
    warnings: [],
  };

  const line = paneRouteLine(explanation);

  expect(line).toBe(`Kimi Coding → OpenRouter  (${describeRouteExplanation(explanation)})`);
  expect(line).not.toContain("(auto)");
});
