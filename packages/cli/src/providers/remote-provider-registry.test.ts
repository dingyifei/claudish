import { describe, expect, test } from "bun:test";
import { resolveRemoteProvider } from "./remote-provider-registry.js";

describe("remote provider registry", () => {
  test("keeps a provider that builds its own endpoint despite an empty base URL", () => {
    const resolved = resolveRemoteProvider("vertex@gemini-2.5-flash");

    expect(resolved).not.toBeNull();
    expect(resolved?.provider.name).toBe("vertex");
    expect(resolved?.modelName).toBe("gemini-2.5-flash");
  });
});
