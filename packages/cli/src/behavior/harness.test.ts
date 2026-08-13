import { describe, expect, it } from "bun:test";
import {
  detectHarnessFacts,
  extractAvailableSkills,
  extractSessionId,
  isAutoModeClassifierRequest,
  looksLikeClassifierShape,
} from "./harness.js";

describe("extractSessionId", () => {
  it("extracts only the session id from Claude Code's JSON-string metadata", () => {
    const deviceId = "abc123";
    const sessionId = "ce7d9e68-f907-444f-9680-69ec3048ce9c";
    const userId = JSON.stringify({
      device_id: deviceId,
      account_uuid: "",
      session_id: sessionId,
    });
    // Reproduce the real wire shape: user_id is a JSON string inside the JSON
    // request, not an already-parsed object.
    const request = JSON.parse(`{"metadata":{"user_id":${JSON.stringify(userId)}}}`);

    const extracted = extractSessionId(request);

    expect(extracted).toBe(sessionId);
    expect(extracted).not.toContain(deviceId);
  });

  const absentCases: Array<[string, unknown]> = [
    ["missing metadata", {}],
    ["missing user_id", { metadata: {} }],
    ["a plain non-JSON string", { metadata: { user_id: "plain-user" } }],
    ["malformed JSON", { metadata: { user_id: '{"session_id":' } }],
    ["JSON without session_id", { metadata: { user_id: JSON.stringify({ device_id: "abc123" }) } }],
    ["an empty session_id", { metadata: { user_id: JSON.stringify({ session_id: "" }) } }],
  ];

  for (const [label, request] of absentCases) {
    it(`returns undefined for ${label}`, () => {
      expect(extractSessionId(request)).toBeUndefined();
    });
  }
});

describe("extractAvailableSkills", () => {
  it("parses entries in listing order, including names with colons and hyphens", () => {
    const systemText = `Before the listing.
The following skills are available for use:
- imagegen: Generate images

- code-review:code-review: Review code carefully
- release-notes-writer: Draft release notes
After the listing, continue with the rest of the system prompt.`;

    expect(extractAvailableSkills(systemText)).toEqual([
      { name: "imagegen", description: "Generate images" },
      { name: "code-review:code-review", description: "Review code carefully" },
      { name: "release-notes-writer", description: "Draft release notes" },
    ]);
  });

  it("stops at the first non-blank non-entry line", () => {
    const systemText = `The following skills are available:
- first-skill: The real listed skill

This is a later system-prompt section.
- not-a-skill: This bullet belongs to that later section`;

    expect(extractAvailableSkills(systemText)).toEqual([
      { name: "first-skill", description: "The real listed skill" },
    ]);
  });

  it("returns an empty list when no skill listing exists", () => {
    expect(extractAvailableSkills("No skills section is present here.")).toEqual([]);
  });

  it("returns an empty list for an empty system prompt", () => {
    expect(extractAvailableSkills("")).toEqual([]);
  });
});

describe("detectHarnessFacts", () => {
  const anchorCases = [
    [
      "You should create your plan at /workspace/.team/plans/assigned-alpha.md before exiting.",
      "/workspace/.team/plans/assigned-alpha.md",
    ],
    [
      "A plan file already exists at /tmp/custom-plan-root/assigned-beta.md and should be updated.",
      "/tmp/custom-plan-root/assigned-beta.md",
    ],
    [
      "Read-only except plan file (/opt/project/private-plans/assigned-gamma.md)",
      "/opt/project/private-plans/assigned-gamma.md",
    ],
  ] as const;

  for (const [reminder, expectedPath] of anchorCases) {
    it(`extracts the assigned path from ${reminder.split(" at ")[0]}`, () => {
      const facts = detectHarnessFacts({ system: reminder, messages: [] });

      expect(facts.planModeActive).toBe(true);
      expect(facts.planFilePath).toBe(expectedPath);
      expect(facts.planDir).toBe(expectedPath.slice(0, expectedPath.lastIndexOf("/")));
    });
  }

  it("honours a non-default plan directory instead of inferring ~/.claude/plans", () => {
    const assignedPath = "/workspace/repo/.custom/approval-plans/session-42.md";
    const facts = detectHarnessFacts({
      system: `Plan mode is active. You should create your plan at ${assignedPath}`,
    });

    expect(facts).toEqual({
      planModeActive: true,
      planFilePath: assignedPath,
      planDir: "/workspace/repo/.custom/approval-plans",
    });
  });

  it("returns inactive facts for ordinary text without a plan anchor", () => {
    const facts = detectHarnessFacts({
      system: "Write a project plan and save useful Markdown documentation.",
      messages: [{ role: "user", content: "Please review docs/plan.md." }],
    });

    expect(facts).toEqual({ planModeActive: false });
  });

  it("finds the latest reminder by scanning a long message array backwards", () => {
    const olderPath = "/tmp/old-plans/old.md";
    const latestPath = "/tmp/latest-plans/current.md";
    const messages = [
      { role: "user", content: `You should create your plan at ${olderPath}` },
      ...Array.from({ length: 2_000 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        content: `ordinary conversation turn ${index}`,
      })),
      {
        role: "user",
        content: `Plan mode still active. A plan file already exists at ${latestPath}`,
      },
    ];

    const facts = detectHarnessFacts({ messages });

    expect(facts.planFilePath).toBe(latestPath);
    expect(facts.planDir).toBe("/tmp/latest-plans");
  });

  it("reads a string system prompt", () => {
    const path = "/tmp/string-system/plan.md";

    expect(detectHarnessFacts({ system: `You should create your plan at ${path}` })).toEqual({
      planModeActive: true,
      planFilePath: path,
      planDir: "/tmp/string-system",
    });
  });

  it("reads text blocks from an array system prompt", () => {
    const path = "/tmp/block-system/plan.md";
    const facts = detectHarnessFacts({
      system: [
        { type: "text", text: "Plan mode is active. " },
        { type: "text", text: `Read-only except plan file (${path})` },
      ],
    });

    expect(facts).toEqual({
      planModeActive: true,
      planFilePath: path,
      planDir: "/tmp/block-system",
    });
  });
});

// ---------------------------------------------------------------------------
// Auto-mode permission classifier
//
// Shapes below are taken from a live capture at Claude Code 2.1.226 (6
// classifier requests, 9 main-loop, 1 startup probe). Fields asserted here are
// the ones detection depends on; the arriving model id, the marker's block
// index and the exact max_tokens are recorded in comments rather than pinned,
// because those are observations that have already drifted once and pinning
// them buys a permanently red test on the next reshuffle.
// ---------------------------------------------------------------------------

const MARKER = "You are a security monitor for autonomous AI coding agents.";
// Real classifier system prompts run ~110 KB; truncated here to the anchor.
const MONITOR_BLOCK = `${MARKER}\n\n## Context\n\n[…truncated…]`;
// Claude Code prepends this as system[0]; cc_version + a per-turn hash follow.
const BILLING_BLOCK = "x-anthropic-billing-header: cc_version=0.0.0; cc_entrypoint=cli;";
const SESSION_CONTEXT_BLOCK = "\n\n## Session Context\n\n[…redacted…]";

/** A captured classifier request, redacted. Arrived as model `claude-sonnet-5`. */
const CLASSIFIER_BODY = {
  model: "claude-sonnet-5",
  max_tokens: 64,
  thinking: { type: "disabled" },
  system: [
    { type: "text", text: BILLING_BLOCK },
    { type: "text", text: MONITOR_BLOCK },
    { type: "text", text: SESSION_CONTEXT_BLOCK },
  ],
  messages: [{ role: "user", content: "[…redacted…]" }],
};

/** A captured main-loop request. */
const MAIN_LOOP_BODY = {
  model: "claude-opus-5",
  max_tokens: 64000,
  stream: true,
  thinking: { type: "adaptive" },
  tools: [{ name: "Bash" }],
  system: [
    { type: "text", text: BILLING_BLOCK },
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: "text", text: "\nYou are an interactive agent that helps users […]" },
  ],
};

/** Claude Code's startup connectivity probe: no system at all. */
const PROBE_BODY = { model: "claude-opus-5", max_tokens: 1 };

describe("isAutoModeClassifierRequest", () => {
  it("matches the captured classifier request (marker is NOT system[0])", () => {
    expect(isAutoModeClassifierRequest(CLASSIFIER_BODY)).toBe(true);
  });

  it("matches system supplied as a plain string", () => {
    expect(isAutoModeClassifierRequest({ system: MONITOR_BLOCK })).toBe(true);
  });

  it("tolerates leading whitespace before the marker", () => {
    expect(
      isAutoModeClassifierRequest({ system: [{ type: "text", text: `\n  ${MONITOR_BLOCK}` }] })
    ).toBe(true);
  });

  it("does NOT match the main-loop request", () => {
    expect(isAutoModeClassifierRequest(MAIN_LOOP_BODY)).toBe(false);
  });

  it("does NOT match the marker quoted mid-block", () => {
    // The vector worth guarding: a CLAUDE.md that quotes the marker lands INSIDE
    // the instructions block, not at its start, so prefix-anchoring excludes it.
    expect(
      isAutoModeClassifierRequest({
        system: [{ type: "text", text: `Project rules:\n\nDo not write "${MARKER}"` }],
      })
    ).toBe(false);
  });

  it("returns false for empty / missing / malformed system", () => {
    expect(isAutoModeClassifierRequest({})).toBe(false);
    expect(isAutoModeClassifierRequest({ system: [] })).toBe(false);
    expect(isAutoModeClassifierRequest({ system: [{ type: "image", source: {} }] })).toBe(false);
    expect(isAutoModeClassifierRequest(null)).toBe(false);
    expect(isAutoModeClassifierRequest("not an object")).toBe(false);
    expect(isAutoModeClassifierRequest({ system: 42 })).toBe(false);
  });
});

describe("looksLikeClassifierShape", () => {
  it("matches the captured classifier request", () => {
    expect(looksLikeClassifierShape(CLASSIFIER_BODY)).toBe(true);
  });

  it("matches the 8192-max_tokens classifier variant seen in the same capture", () => {
    expect(looksLikeClassifierShape({ ...CLASSIFIER_BODY, max_tokens: 8192 })).toBe(true);
  });

  it("does NOT match the main-loop request", () => {
    expect(looksLikeClassifierShape(MAIN_LOOP_BODY)).toBe(false);
  });

  it("does NOT match the startup connectivity probe", () => {
    // The probe is non-streaming, tool-less and tiny — it clears every other
    // gate. Only the multi-block system requirement excludes it, so this test
    // is what keeps that clause from looking removable.
    expect(looksLikeClassifierShape(PROBE_BODY)).toBe(false);
  });

  it("rejects streaming, tool-bearing, and oversized requests individually", () => {
    expect(looksLikeClassifierShape({ ...CLASSIFIER_BODY, stream: true })).toBe(false);
    expect(looksLikeClassifierShape({ ...CLASSIFIER_BODY, tools: [{ name: "Bash" }] })).toBe(false);
    expect(looksLikeClassifierShape({ ...CLASSIFIER_BODY, max_tokens: 64000 })).toBe(false);
    expect(looksLikeClassifierShape({ ...CLASSIFIER_BODY, max_tokens: undefined })).toBe(false);
  });

  it("returns false for malformed bodies", () => {
    expect(looksLikeClassifierShape(null)).toBe(false);
    expect(looksLikeClassifierShape("nope")).toBe(false);
  });
});
