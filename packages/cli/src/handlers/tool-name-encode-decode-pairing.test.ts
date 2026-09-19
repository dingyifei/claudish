/**
 * The tool-name codec must never encode into a wire that cannot decode.
 *
 * Item 7 (`aff8f7f`) turned the 64-char encoder on for every OpenAI-shaped
 * REQUEST and threaded the decode map to the parser — but the two decisions were
 * taken in different places. The encoder asked the adapter
 * (`BaseAPIFormat.getToolNameLimit`, request shape); the parser was chosen by
 * `ComposedHandler.resolveStreamFormat()`, which consults
 * `provider.overrideStreamFormat()` FIRST and no adapter can see. A custom
 * endpoint declaring `{transport:"openai", streamFormat:"anthropic-sse"}` — an
 * aggregator that takes an OpenAI-shaped request and answers in Anthropic SSE —
 * therefore encoded the names and handed the response to a parser with no decode
 * input at all. Claude Code received a tool name it never advertised and its
 * allowlist dropped the call, with no error anywhere.
 *
 * `streamFormat` accepts five values on a custom endpoint, so `gemini-sse` and
 * `ollama-jsonl` pair with the OpenAI transport in exactly the same way. That is
 * why the gate is "does the selected PARSER hold a decoder", not "is this one
 * response wire Anthropic".
 *
 * ## Provenance of the inputs
 *
 * REQUEST-side, plus a composition. `test-fixtures/sse-responses/` holds
 * response streams, not inbound bodies or provider configs, so no capture can
 * reach `prepareRequest` or a ComposedHandler constructor. The providers and
 * payloads below are constructed inline and assert only this tree's own
 * contract. No `.sse` fixture was invented.
 */

import { expect, test } from "bun:test";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { TOOL_NAME_DECODING_WIRES, wireDecodesToolNames } from "../adapters/tool-name-utils.js";
import { OpenAIProviderTransport } from "../providers/transport/openai.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { ComposedHandler } from "./composed-handler.js";
import type { RemoteProvider } from "./shared/remote-provider-types.js";

/** A real one, from the magus browser-use MCP server. 65 characters. */
const REAL_LONG_NAME = "mcp__plugin_browser-use_browser-use__retry_with_browser_use_agent";

function customEndpointProvider(streamFormat?: RemoteProvider["streamFormatOverride"]) {
  return {
    name: "corp-proxy",
    baseUrl: "https://relay.example.invalid",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "CORP_PROXY_API_KEY",
    prefixes: ["corp/"],
    authScheme: "bearer",
    streamFormatOverride: streamFormat,
  } satisfies RemoteProvider;
}

/**
 * Compose exactly what `custom-endpoints-loader.ts` composes for
 * `{transport:"openai", streamFormat:<x>}`, and hand back the adapter so the
 * encode decision can be read off it.
 */
function composeOpenAiTransportEndpoint(
  streamFormat?: RemoteProvider["streamFormatOverride"]
): OpenAIAPIFormat {
  const provider = customEndpointProvider(streamFormat);
  const transport = new OpenAIProviderTransport(provider, "relay-model", "sk-test");
  const adapter = new OpenAIAPIFormat("relay-model");
  new ComposedHandler(transport, "corp@relay-model", "relay-model", 8080, { adapter });
  return adapter;
}

function payloadNamingTheLongTool() {
  return {
    model: "relay-model",
    tools: [{ type: "function", function: { name: REAL_LONG_NAME } }],
    messages: [{ role: "user", content: "go" }],
    tool_choice: { type: "function", function: { name: REAL_LONG_NAME } },
  };
}

// ─── The list of decoding parsers ───────────────────────────────────────────

test("exactly the two parsers that are handed a decode map decode tool names", () => {
  // `ComposedHandler.handleStream` threads `toolNameMap` into these two cases
  // and no others. Adding a wire here without a decode path in its parser
  // re-opens this defect.
  expect([...TOOL_NAME_DECODING_WIRES]).toEqual(["openai-sse", "openai-responses-sse"]);

  expect(wireDecodesToolNames("openai-sse")).toBe(true);
  expect(wireDecodesToolNames("openai-responses-sse")).toBe(true);

  for (const wire of [
    "anthropic-sse",
    "gemini-sse",
    "ollama-jsonl",
    "connect-proto",
  ] as StreamFormat[]) {
    expect(wireDecodesToolNames(wire)).toBe(false);
  }
  // "Nobody said" is treated as "cannot decode": not encoding costs a loud 400
  // on an over-long name; encoding with no decoder drops the call in silence.
  expect(wireDecodesToolNames(undefined)).toBe(false);
});

// ─── The composition decides, not the request shape ─────────────────────────

test("an openai transport answering anthropic-sse does NOT encode", () => {
  const adapter = composeOpenAiTransportEndpoint("anthropic-sse");

  expect(adapter.getToolNameLimit()).toBeNull();

  const payload = payloadNamingTheLongTool();
  adapter.reset();
  adapter.prepareRequest(payload, { messages: [] });

  expect(payload.tools[0].function.name).toBe(REAL_LONG_NAME);
  expect(payload.tool_choice.function.name).toBe(REAL_LONG_NAME);
  // Nothing bound: an empty map is the honest statement that nothing needs
  // decoding, and it is what the anthropic-sse branch cannot accept anyway.
  expect(adapter.getToolNameMap().size).toBe(0);
});

test("the other two undecodable overrides are refused the same way", () => {
  for (const wire of ["gemini-sse", "ollama-jsonl"] as const) {
    expect(composeOpenAiTransportEndpoint(wire).getToolNameLimit()).toBeNull();
  }
});

test("an openai transport answering openai-sse still encodes", () => {
  // The non-regression half: the fix must not switch the codec off for the
  // ordinary custom endpoint, which is every one that declares no streamFormat.
  for (const wire of ["openai-sse", undefined] as const) {
    const adapter = composeOpenAiTransportEndpoint(wire);
    expect(adapter.getToolNameLimit()).toBe(64);

    const payload = payloadNamingTheLongTool();
    adapter.reset();
    adapter.prepareRequest(payload, { messages: [] });

    const onTheWire = payload.tools[0].function.name;
    expect(onTheWire.length).toBe(64);
    expect(onTheWire).not.toBe(REAL_LONG_NAME);
    expect(payload.tool_choice.function.name).toBe(onTheWire);
    expect(adapter.getToolNameMap().get(onTheWire)).toBe(REAL_LONG_NAME);
  }
});

test("a provider override can also ARM the codec, not only disarm it", () => {
  // The override is consulted in both directions. An aggregator normalizes the
  // RESPONSE to openai-sse whatever the adapter declares (OpenRouter and LiteLLM
  // both hardcode that), so a composition whose adapter would answer
  // "anthropic-sse" on its own still gets a decoding parser — and must encode.
  const provider = customEndpointProvider("openai-sse");
  const transport = new OpenAIProviderTransport(provider, "relay-model", "sk-test");
  const adapter = new OpenAIAPIFormat("relay-model", "anthropic-sse");

  // Composed alone it would refuse, on the composed REQUEST wire.
  expect(adapter.getToolNameLimit()).toBeNull();

  new ComposedHandler(transport, "corp@relay-model", "relay-model", 8080, { adapter });
  expect(adapter.getToolNameLimit()).toBe(64);
});
