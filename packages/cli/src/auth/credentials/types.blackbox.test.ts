/**
 * BLACK-BOX. Written by `gpt-6-astra` from the spec and a body-stripped `.d.ts`,
 * with no access to this implementation. See
 * `ai-docs/sessions/dev-feature-alibaba-subscript-20260917/tests/blackbox-results.md`.
 *
 * DO NOT edit an assertion to make it pass. Its value is that its author had
 * never read the code; a repaired assertion is a regression test, not evidence.
 * Adaptation on integration: import path only (`../contract/types` → `./types.js`).
 *
 * Second adaptation, on the port to the current tree: the file-scoped
 * `useBlackboxEnv()` isolation (`test-helpers/blackbox-env.ts`) is not called
 * here. T1 and T2 exercise a pure string function that reads no HOME, no
 * environment and no network, so that harness has nothing to guard in this
 * file, and the harness itself ships with the black-box suites that need it.
 */
import { describe, expect, test } from "bun:test";
import { readinessDetail } from "./types.js";

describe("credential diagnostics remain usable in the billing explanation", () => {
  test("T1 a vault exception retains the reason the user can act on", () => {
    expect(readinessDetail(new Error("1Password handshake denied"))).toContain(
      "1Password handshake denied"
    );
  });
  test("T2 multiline source errors become one bounded diagnostic line", () => {
    const message = `Keychain locked\r\n${"SDK diagnostic detail\n".repeat(2_000)}`;
    const detail = readinessDetail(new Error(message));
    expect(typeof detail).toBe("string");
    expect(detail).toContain("Keychain locked");
    expect(detail).not.toMatch(/[\r\n]/);
    expect(detail!.length).toBeLessThan(message.length);
  });
});
