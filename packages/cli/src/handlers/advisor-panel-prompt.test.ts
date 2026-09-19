import { describe, expect, it } from "bun:test";
import { prepareAdvisorPanelMessages } from "./native-handler-advisor.js";

const advisorToolUseId = "toolu_advisor_panel_001";

function advisorTranscript(input: Record<string, unknown>): any[] {
  return [
    { role: "user", content: [{ type: "text", text: "Help me decide." }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: advisorToolUseId,
          name: "advisor",
          input,
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: advisorToolUseId,
          content: "Error: No such tool available: advisor",
          is_error: true,
        },
      ],
    },
  ];
}

describe("prepareAdvisorPanelMessages", () => {
  it("states the advisor question in the messages sent to the panel", () => {
    const question = "Should we cache the catalog in the proxy or in the CLI?";

    const prepared = prepareAdvisorPanelMessages(advisorTranscript({ question }), advisorToolUseId);

    expect(JSON.stringify(prepared)).toContain(question);
  });

  it("neutralises the plumbing error for the advisor tool-use id", () => {
    const prepared = prepareAdvisorPanelMessages(
      advisorTranscript({ question: "Where should the cache live?" }),
      advisorToolUseId
    );
    const text = JSON.stringify(prepared);

    expect(text).not.toContain("No such tool available");
    expect(text).toContain("handled by the claudish proxy");
  });

  it("preserves another tool result verbatim even when it quotes the plumbing error", () => {
    const otherToolResult = {
      type: "tool_result",
      tool_use_id: "toolu_grep_002",
      content: "Search output quoted: Error: No such tool available: advisor",
      is_error: false,
    };
    const messages = advisorTranscript({ question: "Review the search findings." });
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_grep_002",
          name: "Grep",
          input: { pattern: "No such tool available" },
        },
      ],
    });
    messages.push({ role: "user", content: [otherToolResult] });

    const prepared = prepareAdvisorPanelMessages(messages, advisorToolUseId);
    const preserved = prepared
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block?.tool_use_id === otherToolResult.tool_use_id);

    expect(preserved).toEqual(otherToolResult);
    expect(preserved.content).toBe(otherToolResult.content);
  });

  it("does not mutate the caller's message array", () => {
    const messages = advisorTranscript({ question: "Is this request safe to forward?" });
    const before = structuredClone(messages);

    prepareAdvisorPanelMessages(messages, advisorToolUseId);

    expect(messages).toEqual(before);
  });

  it("turns an empty advisor input into usable panel instructions", () => {
    const prepared = prepareAdvisorPanelMessages(advisorTranscript({}), advisorToolUseId);
    const finalTurn = prepared.at(-1);
    const finalText = finalTurn?.content?.[0]?.text;

    expect(finalTurn?.role).toBe("user");
    expect(typeof finalText).toBe("string");
    expect(finalText.length).toBeGreaterThan(0);
    expect(finalText).toContain("question is the conversation itself");
    expect(finalText).toContain("You are the advisor");
  });
});
