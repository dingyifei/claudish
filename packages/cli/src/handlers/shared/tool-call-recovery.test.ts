import { describe, expect, it } from "bun:test";

import {
  extractToolCallsFromText,
  hasExtractableFunctionTag,
  parseFunctionTagEnvelope,
} from "./tool-call-recovery.js";

describe("extractToolCallsFromText tool-name validation", () => {
  it("rejects a swallowed argument value without breaking Qwen-style recovery", () => {
    const malformed =
      '<function=web_search_query_listOpposed["macos security add-generic-password -X hex password flag"]>';

    expect(extractToolCallsFromText(malformed)).toEqual([]);

    const recovered = extractToolCallsFromText('<function=web_search><parameter=query_list>["x"]');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      name: "web_search",
      arguments: { query_list: '["x"]' },
    });
  });

  it("drops well-shaped unadvertised names only when an allowlist is supplied", () => {
    const text = "<function=Unadvertised><parameter=value>x";

    expect(extractToolCallsFromText(text, ["Read"])).toEqual([]);
    expect(extractToolCallsFromText(text)).toEqual([
      {
        name: "Unadvertised",
        arguments: { value: "x" },
        source: "xml_text",
      },
    ]);
  });

  it("canonicalizes an advertised tool name case-insensitively", () => {
    expect(extractToolCallsFromText("<function=read>", ["Read"])).toEqual([
      {
        name: "Read",
        arguments: {},
        source: "xml_text",
      },
    ]);
  });

  it("rejects tool names longer than 64 characters", () => {
    const tooLong = `A${"a".repeat(64)}`;

    expect(extractToolCallsFromText(`<function=${tooLong}>`)).toEqual([]);
  });

  it("detects exactly the function tags that Pattern 0 can extract", () => {
    const valid = "<function=Read>";
    const invalid = "<function=not a name!>";

    expect(hasExtractableFunctionTag(valid)).toBe(true);
    expect(extractToolCallsFromText(valid)).toHaveLength(1);
    expect(hasExtractableFunctionTag(invalid)).toBe(false);
    expect(extractToolCallsFromText(invalid)).toEqual([]);
  });
});

/**
 * The envelope parser runs BEFORE the six loose regex patterns and
 * short-circuits on success, so its strictness is the only thing keeping that
 * safe. Every case below is about what it REFUSES.
 *
 * No case here claims a model emitted anything — these are the parser's own
 * contract. The positive cases are the existing Qwen recovery cases above, which
 * now flow through this path.
 */
describe("parseFunctionTagEnvelope strictness", () => {
  it("refuses text that merely describes the format", () => {
    expect(parseFunctionTagEnvelope("Use the <function=NAME> format to call a tool.")).toBeNull();
    expect(parseFunctionTagEnvelope("I'll use the Read tool to read the file.")).toBeNull();
    expect(parseFunctionTagEnvelope("")).toBeNull();
  });

  it("refuses an envelope with anything in front of it", () => {
    expect(parseFunctionTagEnvelope("Let me read it: <function=Read><parameter=file_path>/a")).toBe(
      null
    );
  });

  it("refuses a name that is not an identifier, exactly as the shape gate does", () => {
    expect(parseFunctionTagEnvelope("<function=not a name!><parameter=x>1")).toBeNull();
  });

  it("parses two blocks as two calls, each with its own parameters", () => {
    expect(
      parseFunctionTagEnvelope(
        "<function=Read><parameter=file_path>/a\n<function=Bash><parameter=command>ls"
      )
    ).toEqual([
      { name: "Read", arguments: { file_path: "/a" }, source: "xml_text" },
      { name: "Bash", arguments: { command: "ls" }, source: "xml_text" },
    ]);
  });

  it("honours explicit closing tags rather than swallowing them into the value", () => {
    expect(
      parseFunctionTagEnvelope("<function=Read><parameter=file_path>/a</parameter></function>")?.[0]
        ?.arguments
    ).toEqual({ file_path: "/a" });
  });

  it("keeps a multi-line value whole", () => {
    expect(
      parseFunctionTagEnvelope("<function=Write><parameter=file_path>/a\n<parameter=content>x\ny")
    ).toEqual([
      { name: "Write", arguments: { file_path: "/a", content: "x\ny" }, source: "xml_text" },
    ]);
  });

  it("still applies the advertised-tool allowlist through the extractor", () => {
    const envelope = "<function=Unadvertised><parameter=value>x";
    expect(parseFunctionTagEnvelope(envelope)).not.toBeNull();
    expect(extractToolCallsFromText(envelope, ["Read"])).toEqual([]);
  });
});

/**
 * The `<tool_call>`-wrapped envelope.
 *
 * Reproduced live against the published 9.5.0 binary through a mock upstream:
 * the wrapped form produced `{"city":"Paris</parameter></function></tool_call>"}`
 * while the identical unwrapped form produced `{"city":"Paris"}`. The failure is
 * silent — the tool runs on the corrupted argument — so every assertion here
 * checks the VALUE, not merely that a call came out.
 */
describe("parseFunctionTagEnvelope with a <tool_call> wrapper", () => {
  it("parses the wrapped form identically to the unwrapped one", () => {
    const wrapped =
      "<tool_call><function=get_weather><parameter=city>Paris</parameter></function></tool_call>";
    const unwrapped = "<function=get_weather><parameter=city>Paris</parameter></function>";
    expect(parseFunctionTagEnvelope(wrapped)).toEqual(parseFunctionTagEnvelope(unwrapped));
    expect(parseFunctionTagEnvelope(wrapped)).toEqual([
      { name: "get_weather", arguments: { city: "Paris" }, source: "xml_text" },
    ]);
  });

  it("never leaves a closing tag inside the last parameter value", () => {
    const calls = extractToolCallsFromText(
      "<tool_call><function=get_weather><parameter=city>Paris</parameter></function></tool_call>",
      ["get_weather"]
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments.city).toBe("Paris");
    expect(JSON.stringify(calls[0].arguments)).not.toContain("</");
  });

  it("handles several wrapped calls in one response", () => {
    expect(
      parseFunctionTagEnvelope(
        "<tool_call><function=Read><parameter=file_path>/a</parameter></function></tool_call>\n" +
          "<tool_call><function=Bash><parameter=command>ls -la</parameter></function></tool_call>"
      )
    ).toEqual([
      { name: "Read", arguments: { file_path: "/a" }, source: "xml_text" },
      { name: "Bash", arguments: { command: "ls -la" }, source: "xml_text" },
    ]);
  });

  it("accepts a wrapper the stream never closed", () => {
    expect(parseFunctionTagEnvelope("<tool_call><function=Read><parameter=file_path>/a")).toEqual([
      { name: "Read", arguments: { file_path: "/a" }, source: "xml_text" },
    ]);
  });

  it("still refuses a wrapped envelope with prose in front of it", () => {
    expect(
      parseFunctionTagEnvelope(
        "Let me check: <tool_call><function=Read><parameter=file_path>/a</parameter></function></tool_call>"
      )
    ).toBeNull();
  });

  it("leaves the JSON-payload <tool_call> shape to the legacy pattern that owns it", () => {
    const json = '<tool_call>{"name": "Read", "arguments": {"file_path": "/a"}}</tool_call>';
    expect(parseFunctionTagEnvelope(json)).toBeNull();
    // Patterns 1 and 2 both match this shape, so the legacy path returns it
    // twice — pre-existing, and unchanged by the unwrap.
    expect(extractToolCallsFromText(json, ["Read"])).toContainEqual({
      name: "Read",
      arguments: { file_path: "/a" },
      source: "xml_text",
    });
  });
});
