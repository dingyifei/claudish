import { describe, expect, test } from "bun:test";
import { providerShortcutRows } from "./cli.js";
import { isPickableProvider } from "./model-selector.js";
import { BUILTIN_PROVIDERS } from "./providers/provider-definitions.js";
import { TIER_LABEL } from "./providers/routing-rules.js";

describe("providerShortcutRows", () => {
  test("derives every pickable provider and all of its shortcuts from the definitions", () => {
    const rows = providerShortcutRows();
    const pickable = BUILTIN_PROVIDERS.filter(isPickableProvider);

    expect(rows).toHaveLength(pickable.length);
    for (const def of pickable) {
      expect(rows).toContainEqual({
        shortcuts: def.shortcuts,
        displayName: def.displayName,
        kind: def.isLocal ? "local" : def.tier ? TIER_LABEL[def.tier] : "",
      });
    }
  });

  test("includes the shortcuts the old hand-written table omitted", () => {
    const shortcuts = new Set(providerShortcutRows().flatMap((row) => row.shortcuts));

    for (const shortcut of ["ag", "dv", "gk", "mistral", "qtoken", "qcode", "qpay"]) {
      expect(shortcuts.has(shortcut), shortcut).toBe(true);
    }
  });

  test("contains provider facts only, with no concrete model-id column", () => {
    for (const row of providerShortcutRows()) {
      expect(Object.keys(row).sort()).toEqual(["displayName", "kind", "shortcuts"]);
    }
  });
});
