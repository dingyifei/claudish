import { describe, expect, test } from "bun:test";
import {
  CustomEndpointComplexSchema,
  CustomEndpointSchema,
  CustomEndpointSimpleSchema,
} from "./config-schema.js";

function invalidCustomEndpointMessage(input: unknown): string {
  const result = CustomEndpointSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) return "";
  return result.error.issues.map((issue) => issue.message).join(" ");
}

describe("CustomEndpointSimpleSchema", () => {
  test("accepts a valid simple endpoint and round-trips through CustomEndpointSchema", () => {
    const input = {
      kind: "simple" as const,
      url: "https://api.example.com/v1",
      format: "openai" as const,
      apiKey: "sk-test-1234",
      modelPrefix: "example/",
      models: ["model-a", "model-b"],
    };

    const parsed = CustomEndpointSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("accepts minimal simple endpoint without optional fields", () => {
    const input = {
      kind: "simple" as const,
      url: "https://api.example.com",
      format: "anthropic" as const,
      apiKey: "key",
    };

    const parsed = CustomEndpointSimpleSchema.parse(input);
    expect(parsed.kind).toBe("simple");
    expect(parsed.modelPrefix).toBeUndefined();
    expect(parsed.models).toBeUndefined();
  });

  test('accepts authScheme "none" without an apiKey', () => {
    const input = {
      kind: "simple" as const,
      url: "https://keyless.example.com/v1",
      format: "openai" as const,
      authScheme: "none" as const,
    };

    expect(CustomEndpointSimpleSchema.parse(input)).toEqual(input);
  });

  test("rejects a non-URL `url`", () => {
    expect(() =>
      CustomEndpointSimpleSchema.parse({
        kind: "simple",
        url: "not-a-url",
        format: "openai",
        apiKey: "sk",
      })
    ).toThrow();
  });

  test('rejects an empty apiKey unless authScheme is "none", with an actionable message', () => {
    const message = invalidCustomEndpointMessage({
      kind: "simple",
      url: "https://api.example.com",
      format: "openai",
      apiKey: "",
    });

    expect(message).toContain("authScheme");
    expect(message).toContain("none");
    expect(message).not.toContain("Too small");
  });

  test('rejects an omitted apiKey unless authScheme is "none", with the same guidance', () => {
    const message = invalidCustomEndpointMessage({
      kind: "simple",
      url: "https://api.example.com",
      format: "openai",
    });

    expect(message).toContain("authScheme");
    expect(message).toContain("none");
  });

  test('rejects a non-empty apiKey when authScheme is "none"', () => {
    const message = invalidCustomEndpointMessage({
      kind: "simple",
      url: "https://api.example.com",
      format: "openai",
      authScheme: "none",
      apiKey: "should-not-be-sent",
    });

    expect(message).toContain("Remove apiKey");
  });

  test('treats a whitespace-only apiKey as empty when authScheme is "none"', () => {
    const input = {
      kind: "simple" as const,
      url: "https://api.example.com",
      format: "openai" as const,
      authScheme: "none" as const,
      apiKey: "   ",
    };

    expect(CustomEndpointSimpleSchema.parse(input)).toEqual(input);
  });
});

describe("CustomEndpointComplexSchema", () => {
  test("accepts a valid complex endpoint and round-trips through CustomEndpointSchema", () => {
    const input = {
      kind: "complex" as const,
      displayName: "My vLLM",
      transport: "openai" as const,
      baseUrl: "https://vllm.example.com",
      apiPath: "/v1/chat/completions",
      apiKey: "key-xyz",
      authScheme: "bearer" as const,
      headers: { "X-Custom": "value" },
      streamFormat: "openai-sse" as const,
      modelPrefix: "vllm/",
      models: ["llama-3"],
    };

    const parsed = CustomEndpointSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  test("accepts minimal complex endpoint with only required fields", () => {
    const input = {
      kind: "complex" as const,
      displayName: "Minimal",
      transport: "openai" as const,
      baseUrl: "https://example.com",
      apiKey: "k",
    };

    const parsed = CustomEndpointComplexSchema.parse(input);
    expect(parsed.displayName).toBe("Minimal");
    expect(parsed.headers).toBeUndefined();
    expect(parsed.streamFormat).toBeUndefined();
  });

  test('accepts authScheme "none" without an apiKey', () => {
    const input = {
      kind: "complex" as const,
      displayName: "Keyless Gateway",
      transport: "anthropic" as const,
      baseUrl: "https://keyless.example.com",
      authScheme: "none" as const,
    };

    expect(CustomEndpointComplexSchema.parse(input)).toEqual(input);
  });

  test('rejects an omitted apiKey unless authScheme is "none"', () => {
    const message = invalidCustomEndpointMessage({
      kind: "complex",
      displayName: "Missing Credential Declaration",
      transport: "openai",
      baseUrl: "https://api.example.com",
    });

    expect(message).toContain("authScheme");
    expect(message).toContain("none");
  });

  test.each(["bearer", "x-api-key"] as const)(
    "continues to accept %s authentication with a real key",
    (authScheme) => {
      const input = {
        kind: "complex" as const,
        displayName: "Authenticated Gateway",
        transport: "openai" as const,
        baseUrl: "https://authenticated.example.com",
        authScheme,
        apiKey: "real-test-key",
      };

      expect(CustomEndpointComplexSchema.parse(input)).toEqual(input);
    }
  );
});

describe("CustomEndpointSchema (discriminated union)", () => {
  test("rejects an object missing the `kind` field", () => {
    expect(() =>
      CustomEndpointSchema.parse({
        url: "https://api.example.com",
        format: "openai",
        apiKey: "sk",
      })
    ).toThrow();
  });
});
