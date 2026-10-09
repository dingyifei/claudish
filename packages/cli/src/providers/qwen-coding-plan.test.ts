/**
 * Alibaba sells THREE products through three isolated key+host silos. This file
 * pins the third one — the Coding Plan, `qcode@` / `qwen-coding` — against every
 * hand-written table that repeats a fact its definition already holds.
 *
 * ── WHY A DRIFT TEST ──────────────────────────────────────────────────────────
 *
 * Each table below is a second spelling of something `ProviderDefinition` says.
 * A provider missing from one of them is not an error and not visibly wrong: the
 * routing hint prints only the OpenRouter line, and the config TUI's routing
 * panel prints the bare uid as its own explanation. Both were missing for
 * `qwen-coding` while seven other files tested it, so each table is checked
 * here rather than by a look.
 *
 * Everything in this file is hermetic and offline.
 */

import { describe, expect, test } from "bun:test";
import { buildProviderChoices } from "../model-selector.js";
import { probeRowLabel } from "../tui/components/RoutingContent.js";
import { API_KEY_MAP } from "./api-key-map.js";
import { describeMissingCredential, getProviderByName } from "./provider-definitions.js";
import { getProviderApiKeyEnv } from "./routing-hints.js";
import { TIER_LABEL } from "./routing-rules.js";

const CODING = "qwen-coding";
const TOKEN = "qwen-token-plan";
const PAYG = "qwen-payg";

const CODING_KEY = "QWEN_CODING_PLAN_API_KEY";
const TOKEN_KEY = "QWEN_TOKEN_PLAN_API_KEY";
const PAYG_KEY = "DASHSCOPE_API_KEY";

describe("qwen-coding — every hand-written table that shadows the definition", () => {
  test("API_KEY_MAP (the --probe credential rows) agrees with the definition", () => {
    const def = getProviderByName(CODING)!;
    expect(API_KEY_MAP[CODING]).toEqual({ envVar: def.apiKeyEnvVar, aliases: def.apiKeyAliases });
  });

  test("the routing hint names the key, so qcode@ cannot vanish unexplained", () => {
    expect(getProviderApiKeyEnv(CODING)).toBe(CODING_KEY);
  });

  test("the picker offers it, named as a product, next to its siblings", () => {
    const choices = buildProviderChoices();
    const row = choices.find((c) => c.value === CODING);
    expect(row).toBeDefined();
    expect(row!.name).toBe("Alibaba Coding Plan");
    // The metering UNIT is the distinction a user picking a key needs: Credits,
    // requests, tokens.
    expect(row!.description).toContain("requests");

    const order = choices.map((c) => c.value);
    expect(order.indexOf(TOKEN)).toBeLessThan(order.indexOf(CODING));
    expect(order.indexOf(CODING)).toBeLessThan(order.indexOf(PAYG));
  });

  test("the config TUI's routing panel names all three products", () => {
    for (const name of [CODING, TOKEN, PAYG]) {
      const def = getProviderByName(name)!;
      expect(def.tier).toBeDefined();
      expect(
        probeRowLabel({
          displayName: def.displayName,
          status: "pending",
          tier: def.tier,
          position: "candidate",
        })
      ).toBe(`${def.displayName} · ${TIER_LABEL[def.tier!]}`);
    }
  });

  test("a 401 names the other two silos' keys as not-accepted-here", () => {
    // `siblingKeyEnvVars` on all three, because at the routing layer a wrong-silo
    // key and a bad key are the same 401. The clause is explanatory only — no
    // resolution, no signing and no billing reads it.
    const msg = describeMissingCredential(CODING);
    expect(msg).toContain(`Set ${CODING_KEY}`);
    expect(msg).toContain(`${TOKEN_KEY} (${TOKEN})`);
    expect(msg).toContain(`${PAYG_KEY} (${PAYG})`);
    expect(msg).toContain("is not accepted here");

    expect(describeMissingCredential(TOKEN)).toContain(`${CODING_KEY} (${CODING})`);
    expect(describeMissingCredential(PAYG)).toContain(`${TOKEN_KEY} (${TOKEN})`);
    expect(describeMissingCredential(PAYG)).toContain(`${CODING_KEY} (${CODING})`);
  });

  test("nothing in the remedy infers a product from the key's bytes", () => {
    // Alibaba documents `sk-sp-` as the CODING PLAN's format, and the one
    // measured `sk-sp-` key authenticates the TOKEN PLAN. One counter-example is
    // enough: a prefix cannot identify a product.
    for (const name of [CODING, TOKEN, PAYG]) {
      const msg = describeMissingCredential(name).toLowerCase();
      expect(msg).not.toContain("sk-sp");
      expect(msg).not.toContain("prefix");
      expect(msg).not.toContain("starts with");
    }
  });
});
