import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./types.js";

describe("credential readiness redaction", () => {
  test("redacts a Google key carried in a URL query parameter", () => {
    const secret = "AIzaSyD-1234567890abcdefghijklmnopqrs";
    const output = redactSecrets(`request failed: https://example.test/models?key=${secret}`);

    expect(output).toBe("request failed: https://example.test/models?key=[redacted]");
    expect(output).not.toContain(secret);
  });

  test("redacts a bearer token while retaining the authentication scheme", () => {
    const secret = "eyJhbGciOiJIUzI1NiJ9.fake-token-signature";
    const output = redactSecrets(`Authorization: Bearer ${secret}`);

    expect(output).toBe("Authorization: Bearer [redacted]");
    expect(output).not.toContain(secret);
  });

  // Synthetic values only, and deliberately NOT in each vendor's real token
  // shape. A fixture that mimics the real layout (Slack's `xoxb-<digits>-<alnum>`
  // was the one that did) trips GitHub's push protection and blocks the release,
  // even though nothing here is a live credential. These still exercise the
  // regexes, which only require the prefix plus a run of allowed characters.
  test.each([
    ["sk-", "sk-EXAMPLEFAKEVALUENOTREAL"],
    ["ghp_", "ghp_EXAMPLEFAKEVALUENOTREALabcdefghij"],
    ["xoxb-", "xoxb-EXAMPLE-FAKE-VALUE-NOT-REAL"],
  ])("retains the %s credential prefix while removing its secret", (prefix, secret) => {
    const output = redactSecrets(`credential ${secret} failed`);

    expect(output).toContain(`${prefix}[redacted]`);
    expect(output).not.toContain(secret);
  });

  test("leaves a request id, model id, and plain diagnostic unchanged", () => {
    const input =
      "request req_01JZ8M6Y7Q2K9V4W3X1C failed for model gemini-3.8-flash: quota exhausted";

    expect(redactSecrets(input)).toBe(input);
  });
});
