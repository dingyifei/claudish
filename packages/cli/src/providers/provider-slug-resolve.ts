/**
 * Resolve what a user typed after `--models --provider` against the catalog's
 * own provider vocabulary.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Three vocabularies name providers and they are NOT the same list
 * (`ai-docs/architecture/routing.md`):
 *
 *  1. the catalog's VENDOR SLUG — `moonshotai`, `z-ai`, `x-ai` — which is what
 *     `--providers` lists and what the hosted `?provider=` query matches;
 *  2. claudish's ROUTING PREFIX — `moonshot@`, `kimi@`, `gk@` — which is what
 *     `--model` takes;
 *  3. the picker's display label.
 *
 * `--provider moonshot` answered
 *
 *     No active models found for provider "moonshot".
 *
 * which states a fact about the CATALOG that is not true — the vendor is in it,
 * under `moonshotai`, with 6 active models. `moonshot` is vocabulary 2: a
 * routing shortcut for the `kimi` builtin. The message sent a user to look for
 * missing data instead of at the spelling, and an empty answer for a name that
 * works everywhere else in the CLI reads as a claudish bug.
 *
 * So the resolver answers three DIFFERENT questions separately, because they
 * have three different remedies: the slug matched (query it), the slug is not
 * in the catalog's vocabulary (name what is), or the slug is a routing prefix
 * the user is entitled to think is a provider name (say which vocabulary it
 * belongs to).
 *
 * Nothing here is hardcoded. The valid slugs come from the live catalog and the
 * routing tokens from `reservedNamespaceOwner`, which builds itself from
 * `BUILTIN_PROVIDERS` at call time.
 */

import { reservedNamespaceOwner } from "./reserved-namespace.js";

/** One row of the catalog's provider list, as `getProviderList()` returns it. */
export interface CatalogProvider {
  slug: string;
  count: number;
}

export interface ProviderSlugResolution {
  /**
   * `"match"` — query the catalog with `canonical`.
   * `"unknown"` — the catalog's vocabulary does not contain this token.
   */
  kind: "match" | "unknown";
  /** The catalog's OWN spelling of the slug, for a match. */
  canonical: string | null;
  /** Catalog slugs worth suggesting, best first, at most `SUGGESTION_LIMIT`. */
  suggestions: CatalogProvider[];
  /**
   * The builtin provider that answers to this token as a ROUTING prefix, when
   * one does. `moonshot` → `kimi`. Set even for a match (`openai` is both), so
   * the caller decides when it is worth mentioning.
   */
  routingOwner: string | null;
}

const SUGGESTION_LIMIT = 5;
/** Shortest shared prefix worth calling a near miss. `z-a` → `z-ai`, not `x` → everything. */
const MIN_PREFIX_OVERLAP = 3;

function sharedPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Rank the catalog slugs that a typed token plausibly meant.
 *
 * Substring relatedness first (`moonshot` ↔ `moonshotai`), then a shared
 * prefix, then by active-model count so the busiest vendor leads. Deliberately
 * NOT an edit-distance search: a fuzzy match that confidently suggests the
 * wrong vendor is worse than suggesting nothing, and `--providers` is one line
 * away.
 */
function rankSuggestions(typed: string, providers: CatalogProvider[]): CatalogProvider[] {
  const needle = typed.toLowerCase();
  const scored: Array<{ provider: CatalogProvider; score: number }> = [];
  for (const provider of providers) {
    const slug = provider.slug.toLowerCase();
    let score = 0;
    if (slug.includes(needle) || needle.includes(slug)) {
      score = 2;
    } else if (sharedPrefixLength(slug, needle) >= MIN_PREFIX_OVERLAP) {
      score = 1;
    }
    if (score > 0) scored.push({ provider, score });
  }
  scored.sort((a, b) => b.score - a.score || b.provider.count - a.provider.count);
  return scored.slice(0, SUGGESTION_LIMIT).map((s) => s.provider);
}

/**
 * Decide how to treat `typed` against the catalog's provider list.
 *
 * `providers` empty means the list could not be fetched. The resolver then
 * FAILS OPEN — `kind: "match"` with the token as given — so a catalog outage
 * degrades to the old behaviour (ask the backend and print what it says) rather
 * than to a confident "that is not a provider". A validator that rejects when
 * it cannot reach its own vocabulary is worse than no validator.
 */
export function resolveProviderSlug(
  typed: string,
  providers: CatalogProvider[]
): ProviderSlugResolution {
  const routingOwner = reservedNamespaceOwner(typed) ?? null;

  if (providers.length === 0) {
    return { kind: "match", canonical: typed, suggestions: [], routingOwner };
  }

  const exact = providers.find((p) => p.slug.toLowerCase() === typed.toLowerCase());
  if (exact) {
    return { kind: "match", canonical: exact.slug, suggestions: [], routingOwner };
  }

  return {
    kind: "unknown",
    canonical: null,
    suggestions: rankSuggestions(typed, providers),
    routingOwner,
  };
}
