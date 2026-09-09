import { describe, expect, test } from "bun:test";
import { resolveProviderDetailKeyDisplay } from "./ProviderDetail.js";

describe("resolveProviderDetailKeyDisplay", () => {
  test("shows OAuth as the active credential instead of an empty key", () => {
    expect(
      resolveProviderDetailKeyDisplay({
        isLocal: false,
        isReady: true,
        authSource: "oauth",
        hasEnvKey: false,
        hasCfgKey: false,
        envKeyMask: "",
        cfgKeyMask: "",
      })
    ).toBe("oauth");
  });

  test("keeps the runtime env key ahead of a shadowed config key", () => {
    expect(
      resolveProviderDetailKeyDisplay({
        isLocal: false,
        isReady: true,
        authSource: "e+c",
        hasEnvKey: true,
        hasCfgKey: true,
        envKeyMask: "env-mask",
        cfgKeyMask: "cfg-mask",
      })
    ).toBe("env-mask");
  });
});
