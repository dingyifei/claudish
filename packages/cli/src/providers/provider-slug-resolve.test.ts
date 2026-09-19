import { describe, expect, it } from "bun:test";

import { BUILTIN_PROVIDERS } from "./provider-definitions.js";
import { type CatalogProvider, resolveProviderSlug } from "./provider-slug-resolve.js";

/**
 * A stand-in for `getProviderList()`. Shaped like the live answer — slug plus
 * active-model count — but fixed, so the assertions are about the resolver and
 * not about what the catalog happens to hold today.
 */
const CATALOG: CatalogProvider[] = [
  { slug: "qwen", count: 314 },
  { slug: "google", count: 121 },
  { slug: "openai", count: 104 },
  { slug: "z-ai", count: 46 },
  { slug: "x-ai", count: 23 },
  { slug: "moonshotai", count: 6 },
  { slug: "openrouter", count: 15 },
];

describe("resolveProviderSlug", () => {
  it("matches a catalog slug and hands back the catalog's own spelling", () => {
    expect(resolveProviderSlug("x-ai", CATALOG)).toMatchObject({
      kind: "match",
      canonical: "x-ai",
    });
  });

  it("canonicalizes case rather than rejecting it", () => {
    expect(resolveProviderSlug("MoonshotAI", CATALOG)).toMatchObject({
      kind: "match",
      canonical: "moonshotai",
    });
  });

  it("calls a routing prefix unknown, and names the vendor it plausibly meant", () => {
    // The reported defect: `--provider moonshot` answered "no active models",
    // which is a false claim about the catalog — the vendor is in it as
    // `moonshotai`, with 6 active models.
    const resolved = resolveProviderSlug("moonshot", CATALOG);
    expect(resolved.kind).toBe("unknown");
    expect(resolved.suggestions.map((s) => s.slug)).toEqual(["moonshotai"]);
  });

  it("names the builtin that owns the token as a routing prefix", () => {
    const resolved = resolveProviderSlug("moonshot", CATALOG);
    // Not pinned to a literal: the owner is whatever BUILTIN_PROVIDERS says
    // today, and the assertion is that the answer is a real builtin.
    expect(resolved.routingOwner).not.toBeNull();
    expect(BUILTIN_PROVIDERS.map((p) => p.name)).toContain(resolved.routingOwner as string);
  });

  it("reports no routing owner for a token that is not one", () => {
    expect(resolveProviderSlug("nope-vendor-xyz", CATALOG).routingOwner).toBeNull();
  });

  it("offers nothing rather than a confident wrong guess", () => {
    const resolved = resolveProviderSlug("nope-vendor-xyz", CATALOG);
    expect(resolved.kind).toBe("unknown");
    expect(resolved.suggestions).toEqual([]);
  });

  it("ranks a substring match above a shared prefix, and busier vendors first", () => {
    const resolved = resolveProviderSlug("open", CATALOG);
    expect(resolved.kind).toBe("unknown");
    expect(resolved.suggestions.map((s) => s.slug)).toEqual(["openai", "openrouter"]);
  });

  it("fails OPEN when the provider list could not be fetched", () => {
    // A validator that rejects when it cannot reach its own vocabulary would
    // turn a catalog outage into "that is not a provider".
    expect(resolveProviderSlug("x-ai", [])).toMatchObject({
      kind: "match",
      canonical: "x-ai",
      suggestions: [],
    });
  });
});
