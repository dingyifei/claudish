import { afterEach, describe, expect, test } from "bun:test";
import { stripAnsi, visibleWidth } from "./ansi-viz.js";
import type { SessionStats } from "./session-stats.js";
import { renderSessionSummary } from "./session-summary.js";

const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");

afterEach(() => {
  if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
  else Reflect.deleteProperty(process.stdout, "columns");
});

function setTerminalWidth(columns: number): void {
  Object.defineProperty(process.stdout, "columns", {
    configurable: true,
    value: columns,
  });
}

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    inputTokens: 120_000,
    outputTokens: 8_000,
    totalTokens: 128_000,
    costUsd: 0.42,
    isFree: false,
    isEstimated: false,
    providerName: "test-provider",
    modelName: "test-model",
    contextWindow: 200_000,
    contextUsed: 0.6,
    toolCalls: [{ name: "Read", count: 4 }],
    toolCallTotal: 4,
    durationMs: 754_000,
    savings: [],
    inputCostUsd: 0.12,
    outputCostUsd: 0.3,
    billedInputTokens: 240_000,
    ...overrides,
  };
}

function render(
  overrides: {
    stats?: Partial<SessionStats>;
    modelSpec?: string;
    resumeModelSpec?: string | null;
    resumeId?: string | null;
    resumeCwd?: string | null;
    exitCode?: number;
  } = {}
): string[] {
  return renderSessionSummary({
    stats: makeStats(overrides.stats),
    modelSpec: overrides.modelSpec ?? "provider@test-model",
    resumeModelSpec:
      overrides.resumeModelSpec === undefined ? "provider@test-model" : overrides.resumeModelSpec,
    resumeId: overrides.resumeId === undefined ? "session-123" : overrides.resumeId,
    resumeCwd: overrides.resumeCwd,
    exitCode: overrides.exitCode ?? 0,
  });
}

describe("renderSessionSummary box geometry", () => {
  test("every bordered row aligns at narrow, normal, and capped terminal widths", () => {
    const longTool = "mcp__some-really-long-server-name__a_very_long_tool_name";
    const longModel =
      "provider@an-extremely-long-model-spec-that-would-overflow-a-card-without-display-cell-clipping";

    for (const terminalWidth of [64, 80, 120]) {
      setTerminalWidth(terminalWidth);
      const lines = render({
        modelSpec: longModel,
        resumeModelSpec: longModel,
        stats: {
          toolCalls: [{ name: longTool, count: 17 }],
          toolCallTotal: 17,
        },
      });
      const box = lines.filter((line) => {
        const plain = stripAnsi(line);
        return plain.startsWith("╭") || plain.startsWith("│") || plain.startsWith("╰");
      });
      const borderWidth = visibleWidth(box[0]!);

      expect(box.length).toBeGreaterThan(2);
      expect(visibleWidth(box.at(-1)!)).toBe(borderWidth);
      for (const line of box.filter((candidate) => stripAnsi(candidate).startsWith("│"))) {
        expect(visibleWidth(line)).toBe(borderWidth);
      }
    }
  });
});

describe("renderSessionSummary resume command", () => {
  test("the final line is a completely unstyled copyable command", () => {
    const lines = render({ resumeModelSpec: "x@y", resumeId: "resume-me" });
    const command = lines.at(-1)!;

    expect(command.startsWith("claudish ")).toBe(true);
    expect(command).toContain("--model x@y");
    expect(command).toContain("--resume resume-me");
    expect(command).not.toContain("\x1b");
  });

  test("omits --model rather than guessing for a profile-role session", () => {
    const command = render({ resumeModelSpec: null, resumeId: "profile-session" }).at(-1)!;

    expect(command).toContain("--resume profile-session");
    expect(command).not.toContain("--model");
  });

  test("prepends the worktree directory without styling or unnecessary quotes", () => {
    const ordinary = render({ resumeCwd: "/tmp/claudish-worktree" }).at(-1)!;
    const spaced = render({ resumeCwd: "/tmp/claudish worktree" }).at(-1)!;

    expect(ordinary).toBe(
      "cd /tmp/claudish-worktree && claudish --model provider@test-model --resume session-123"
    );
    expect(spaced).toBe(
      "cd '/tmp/claudish worktree' && claudish --model provider@test-model --resume session-123"
    );
    expect(ordinary).not.toContain("\x1b");
    expect(spaced).not.toContain("\x1b");
  });

  test("leaves the resume command unchanged when its directory is null or absent", () => {
    const absent = render().at(-1)!;
    const nullDirectory = render({ resumeCwd: null }).at(-1)!;

    expect(absent).toBe("claudish --model provider@test-model --resume session-123");
    expect(nullDirectory).toBe(absent);
  });

  test("omits the entire resume section when no session id was found", () => {
    const plain = render({ resumeId: null }).map(stripAnsi);

    expect(plain.some((line) => line.startsWith("claudish "))).toBe(false);
    expect(plain.some((line) => line.includes("Resume this session with:"))).toBe(false);
  });
});

describe("renderSessionSummary status and cost wording", () => {
  test("marks a non-zero child exit as failed and displays its exit badge", () => {
    const plain = render({ exitCode: 23 }).map(stripAnsi);

    expect(plain[0]).toContain("failed");
    expect(plain.some((line) => line.includes("EXIT 23"))).toBe(true);
  });

  test("renders a free session without a dollar amount on the cost row", () => {
    const plain = render({
      stats: { isFree: true, costUsd: 0, inputCostUsd: 0, outputCostUsd: 0 },
    }).map(stripAnsi);
    const costRow = plain.find((line) => line.includes("cost"))!;

    expect(costRow).toContain("free");
    expect(costRow).not.toContain("$");
  });

  test("labels negative savings as overage and never as saved", () => {
    const plain = render({
      stats: {
        savings: [
          {
            label: "Opus",
            modelId: "claude-opus-test",
            baselineUsd: 0.25,
            savedUsd: -0.17,
          },
        ],
      },
    }).map(stripAnsi);
    const savingRow = plain.find((line) => line.includes("vs Opus"))!;

    expect(savingRow).toContain("over by");
    expect(savingRow).not.toContain("saved");
  });

  test("scales free-session savings bars by dollar magnitude", () => {
    const plain = render({
      stats: {
        isFree: true,
        costUsd: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
        savings: [
          { label: "Opus", modelId: "opus", baselineUsd: 1, savedUsd: 1 },
          { label: "Sonnet", modelId: "sonnet", baselineUsd: 0.4, savedUsd: 0.4 },
        ],
      },
    }).map(stripAnsi);
    const opus = plain.find((line) => line.includes("vs Opus"))!;
    const sonnet = plain.find((line) => line.includes("vs Sonnet"))!;
    const filledCells = (line: string): number => line.match(/█/g)?.length ?? 0;

    expect(filledCells(opus)).toBeGreaterThan(filledCells(sonnet));
    expect(opus).toContain("100% saved $1.00");
    expect(sonnet).toContain("100% saved $0.40");
  });
});
