/**
 * Shared helpers for ~/.claudish/all-models.json
 *
 * This file is written and read by four independent consumers:
 *   - providers/catalog-resolvers/openrouter.ts (v2 authoritative — Firebase slim catalog)
 *   - cli.ts (fetchRemoteModels + printAllModels)
 *   - mcp-server.ts (loadAllModels)
 *   - model-selector.ts (fetchAllModels + shouldRefreshForFreeModels)
 *
 * Historically each consumer wrote its own v1-shape `{lastUpdated, models}` blob,
 * clobbering the v2 `entries` array that the OpenRouter catalog resolver relies on.
 *
 * This module provides a single normalized v2 read/write API:
 *   - `readAllModelsCache()` returns a v2 shape (normalizing v1 files on the fly)
 *   - `writeAllModelsCache(partial)` merges with the existing file so callers that
 *     only supply `models` do NOT destroy the Firebase `entries` catalog.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AggregatorEntry } from "../model-loader.js";
import { readCatalogIncompatibility } from "./catalog-compatibility.js";

/**
 * Slim catalog entry from the Firebase queryModels?catalog=slim endpoint.
 * Contains model name resolution data plus optional model metadata.
 *
 * The slim catalog includes `aggregators` per entry — verified live against
 * `?catalog=slim` (see `models-index/functions/src/query-handler.ts:267-269`).
 * This is the multi-aggregator routing index used by `CatalogClient` to
 * answer "which vendors serve model X?" without a Firebase round-trip.
 */
/**
 * How a model exposes its reasoning depth, as reported by the slim catalog.
 *
 * - `toggle`   — reasoning is on/off only; there is no depth parameter.
 * - `effort`   — a discrete level from the model's own `efforts` list.
 * - `adaptive` — the model chooses; a level may optionally be suggested.
 * - `budget`   — a token budget (`budget_tokens`).
 * - `none`     — the model exposes no knob. The catalog pairs it with
 *   `supported: false`, and `query-handler.ts` also uses it as the default for
 *   an entry that carries no `reasoning` block at all, so it is the single
 *   commonest value on the wire rather than an edge case.
 *
 * Kept as a string union of what Firebase currently emits, but consumers must
 * treat an unrecognized value as "no information" rather than an error —
 * the catalog is external data and may grow new kinds.
 *
 * `none` was missing here until 2026-09-15 while the backend had always sent
 * it (`models-index/functions/src/schema.ts:105` declares the same five, and
 * `schema-runtime.ts:610` validates against them). Nothing failed at runtime,
 * because every consumer tests for the value it wants — `control === "effort"`,
 * `control === "budget"` — so an unlisted member falls through to the right
 * answer. It failed at the type level instead: a test fixture could not write
 * the value the live catalog returns, which is how the gap surfaced.
 */
export type ReasoningControl = "toggle" | "effort" | "adaptive" | "budget" | "none";

/**
 * Per-model reasoning capability from the Firebase slim catalog.
 *
 * This is the ONLY sanctioned source for "does this model take an effort
 * level / a token budget / just an on-switch?". Hardcoding that per model is
 * exactly the data that goes stale (a `control: "toggle"` model handed a
 * `budget_tokens` is being sent a parameter it does not expose).
 */
export interface ReasoningCapability {
  /** Whether the model can reason at all. */
  supported: boolean;
  /** Which knob the model exposes. Absent = unknown. */
  control?: ReasoningControl;
  /** Whether reasoning cannot be turned off. */
  mandatory?: boolean;
  /** The discrete levels this model advertises (catalog vocabulary). */
  efforts?: string[];
  /** The level the provider applies when none is requested. */
  defaultEffort?: string;
  /** Whether an explicit `budget_tokens` is accepted. */
  supportsBudgetTokens?: boolean;
}

/**
 * How a provider-preset variant relates to its base model.
 *
 * The catalog lists a preset variant (e.g. `gemini-3.6-flash-high`) as its own
 * top-level model, and `routeVariant` is the back-pointer: which family it
 * belongs to, which base model it presets, and whether it is that family's
 * default. `isDefault` is the authoritative answer to "if the user names the
 * family, which variant should we send?" — a fact the client cannot derive,
 * because the variant suffix is provider vocabulary, not a version number.
 */
export interface RouteVariant {
  /** Discriminator, e.g. `provider-preset`. Treat unknown kinds as no info. */
  kind: string;
  /** The catalog model this variant presets (e.g. `gemini-3.6-flash`). */
  baseModelId?: string;
  /** The family a user would name (e.g. `gemini-3.1-pro`). */
  familyId?: string;
  /** The serving provider this variant exists on (e.g. `antigravity`). */
  provider?: string;
  /** Provider vocabulary for the preset (e.g. `reasoning-tier=high`). */
  preset?: string;
  /** Whether this variant is the family's default on that provider. */
  isDefault?: boolean;
}

/**
 * Which wire API a model is reachable on, keyed by transport family.
 *
 * `api` names the concrete endpoint shape (`chat-completions` / `responses` /
 * `anthropic-messages` / `gemini`), and `toolsWithReasoning` records whether
 * tools and reasoning can be combined on it — `requires-responses` means the
 * Chat Completions path cannot carry both.
 */
export interface ModelEndpoint {
  api?: string;
  toolsWithReasoning?: string;
}

export interface SlimModelEntry {
  modelId: string;
  aliases: string[];
  sources: Record<string, { externalId: string }>;
  /** Official/curated release date in ISO date format, when Firebase has one */
  releaseDate?: string;
  /** Context window in tokens (present when Firebase has it) */
  contextWindow?: number;
  /**
   * The model's own output ceiling, when the catalog publishes one.
   *
   * ABSENT MEANS UNKNOWN, never zero. The slim projection omits the field
   * entirely when it has no value, and it does NOT carry the
   * `maxOutputTokensNotApplicable` flag that the fuller projections use — so
   * "no number here" cannot be told apart from "the concept does not apply to
   * this model", and both must be treated as "we do not know".
   *
   * A reasoning budget is clamped against the REQUEST's ceiling rather than
   * this one (`max_tokens` is what the provider validates against), so this
   * value informs reporting, not request shaping.
   */
  maxOutputTokens?: number;
  /**
   * Whether the catalog KNOWS this model's reasoning control.
   *
   * `"known"` — the `reasoning` record below describes the real wire control.
   * `"unknown"` — the source never described it. This is NOT the same as an
   * explicit unsupported record (`reasoning.supported === false`), and the two
   * demand opposite behaviour: unsupported means "switch reasoning off",
   * unknown means "emit no reasoning knob at all and change nothing".
   *
   * Absent on caches written before the field existed. Treat absent as
   * `"known"` only when a `reasoning` record is present — see
   * {@link reasoningStatusOf}, which is the single place that rule lives.
   *
   * Do NOT derive a control from {@link supportsThinking} when this is
   * `"unknown"`. The backend sets `reasoningStatus: "unknown"` while still
   * publishing `supportsThinking` from coarse capability data, so the flag is
   * present precisely in the case where it proves nothing about the knob.
   */
  reasoningStatus?: "known" | "unknown";
  /**
   * Reasoning capability (present when Firebase has it). Already carried by the
   * on-disk `?catalog=slim` payload; the type previously dropped it, so every
   * consumer had to guess a model's reasoning knob instead of reading it.
   */
  reasoning?: ReasoningCapability;
  /** Whether model supports vision/image input (present when Firebase has it) */
  supportsVision?: boolean;
  /**
   * Multi-aggregator routing index. Each entry is `{provider, externalId, confidence}`.
   * Populated by Firebase ingest from per-source data. Optional — older cache
   * files may not include this field.
   */
  aggregators?: AggregatorEntry[];
  /**
   * Subscription plan ids that include this model (e.g. `["kimi-code"]`).
   * Populated by Firebase ingest. Used by routing to decide whether a
   * subscription endpoint can serve a given model at all — a plan that doesn't
   * list the model would reject it, so the candidate is dropped rather than
   * silently substituted. Optional — older cache files may not include it.
   */
  subscriptionPlans?: string[];
  /**
   * Whether the model accepts tool/function definitions. Shipped by the catalog
   * for ~97% of models.
   */
  supportsTools?: boolean;
  /**
   * Whether the model can produce thinking/reasoning content at all. Coarser
   * than {@link ReasoningCapability} (which describes the KNOB); this is the
   * plain yes/no.
   */
  supportsThinking?: boolean;
  /**
   * The name of the output-token parameter this model's API expects —
   * `max_tokens`, `max_completion_tokens`, or `max_output_tokens`.
   *
   * This exists because the correct parameter is NOT derivable from the model
   * name. Guessing it from a version substring (`gpt-5` → max_completion_tokens)
   * is wrong for the gpt-5.6-* family, which takes `max_output_tokens`, and
   * breaks silently for every model released after the guess was written.
   */
  tokenParam?: string;
  /** Preset-variant back-pointer — see {@link RouteVariant}. */
  routeVariant?: RouteVariant;
  /** Wire APIs this model is reachable on, keyed by transport family. */
  endpoints?: Record<string, ModelEndpoint>;
}

/**
 * Whether this entry's reasoning control is KNOWN, for entries written by any
 * catalog version.
 *
 * The backend always sends `reasoningStatus` now, so the live path is a plain
 * read. The inference below exists only for a cache written before the field
 * shipped, and it is deliberately conservative: a `reasoning` record is
 * self-describing, so its presence means known; its absence on an old cache is
 * indistinguishable from "never described", so it reads unknown.
 *
 * That inference matches what the backend itself does
 * (`reasoningStatus: reasoning !== undefined ? "known" : "unknown"`), so an old
 * cache degrades to the same answer a fresh one would give rather than to a
 * guess of its own.
 */
export function reasoningStatusOf(entry: SlimModelEntry): "known" | "unknown" {
  if (entry.reasoningStatus === "known" || entry.reasoningStatus === "unknown") {
    return entry.reasoningStatus;
  }
  return entry.reasoning !== undefined ? "known" : "unknown";
}

/**
 * How one exact plan roster id resolves to a canonical catalog description.
 *
 * The KEY this is stored under is the wire id the provider expects for
 * inference; `modelId` is the canonical id that carries the metadata. They are
 * frequently different (`claude-opus-4-5-20251101` is the wire id, the row is
 * stored undated), and conflating them is the whole point of the map: resolve
 * metadata through `modelId`, keep sending the key.
 *
 * `missing` and `ambiguous` are explicit negative answers, not absence. They
 * say the catalog looked and could not resolve the id, which is information —
 * it must not be read as "this model has no reasoning" or as grounds to drop a
 * subscription route.
 */
export type CatalogPlanModelDescription =
  | { status: "described"; modelId: string }
  | { status: "missing" | "ambiguous" };

export type SubscriptionModelDiscovery = "catalog" | "client" | "hybrid";

/** Minimal queryPlans projection needed by the synchronous routing engine. */
export interface CachedSubscriptionPlan {
  /** Canonical commercial plan ID referenced by SlimModelEntry.subscriptionPlans. */
  id: string;
  /**
   * The VENDOR selling the plan (`alibaba`, `z-ai`, `moonshotai`) — not a
   * routing identity. Several plans can share one vendor while only some carry a
   * `routing` block, which is exactly what `resolveSubscriptionRouting` needs it
   * for: to notice that its view of a vendor's plans is incomplete and withhold
   * a `not-served` verdict. Do not use it to route; use `routing.providerUid`.
   */
  provider?: string;
  /** Where the exact callable roster comes from. */
  modelDiscovery?: SubscriptionModelDiscovery;
  /** Consumer routing identity; absent when the catalog has no supported route. */
  routing?: {
    providerUid: string;
    prefix?: string;
    nativeModelProviders?: string[];
  };
  /**
   * Exact plan roster id → canonical catalog description.
   *
   * Published for routed catalog/hybrid plans. Absent on `client`-discovery
   * plans, whose `includedModels` are display labels rather than wire ids, and
   * absent on caches written before the field shipped — in both cases callers
   * fall back to matching the id directly against the catalog.
   */
  modelDescriptions?: Record<string, CatalogPlanModelDescription>;
}

/**
 * Disk cache format (version 2).
 * Contains both the slim Firebase data (for resolver) and a backward-compatible
 * models array (for existing consumers in cli.ts/mcp-server.ts that expect {id: string}).
 */
export interface DiskCacheV2 {
  version: 2;
  lastUpdated: string;
  entries: SlimModelEntry[];
  /** Backward-compatible: [{id: "vendor/model"}] for legacy consumers */
  models: Array<{ id: string }>;
  /** Additive queryPlans cache. Absent on legacy v2 files. */
  plans?: CachedSubscriptionPlan[];
  /**
   * The catalog generation every page in `entries` AND `plans` was read from.
   *
   * Recorded so the file can state which snapshot it is, rather than being an
   * undated merge. A refresh writes this only when every page and the plans
   * document agreed on one revision, so its presence is the assertion that the
   * file is internally consistent. Absent on files written before pinning
   * existed, which are still readable and are simply not known to be coherent.
   */
  catalogRevision?: string;
}

export const ALL_MODELS_CACHE_PATH = join(homedir(), ".claudish", "all-models.json");

/**
 * Read the cache from disk, normalizing legacy v1 files to a v2 shape.
 *
 * Returns null if the file doesn't exist or is unparseable.
 * A legacy v1 file `{lastUpdated, models}` is normalized to
 * `{version: 2, lastUpdated, entries: [], models}` so callers can treat both
 * the same way.
 *
 * Returns null unconditionally once a catalog incompatibility has been
 * recorded, whatever is on disk. This file is v2 and the reader is v2, so a
 * parse would SUCCEED — that is the trap. The rows would be structurally valid
 * and semantically obsolete: `subscriptionPlans` naming plan ids the server has
 * since redefined, `aggregators` missing whatever v3 added. `adapters/model-catalog.ts`
 * joins on those fields to decide whether a subscription covers a model, and a
 * confident wrong "no" there is the mis-billing this whole mechanism exists to
 * stop. The stale file stays put rather than being deleted — it is the last
 * known good catalog for the build that CAN read it, and `claudish update`
 * should not have to re-download it.
 *
 * @param path Override the cache path. Defaults to `ALL_MODELS_CACHE_PATH`.
 *             Only tests should pass this.
 */
export function readAllModelsCache(path: string = ALL_MODELS_CACHE_PATH): DiskCacheV2 | null {
  if (readCatalogIncompatibility()) return null;
  return readCacheFile(path);
}

/**
 * The parse, without the contract gate.
 *
 * Split out for exactly one caller — {@link writeAllModelsCache}'s anti-clobber
 * merge, which is asking "what is already in this FILE?", not "may this process
 * route off it?". Routing them both through the gated read would make a legacy
 * `models`-only writer silently erase the `entries` catalog whenever a sentinel
 * was set, destroying the last-known-good file for the updated build that could
 * still have read it.
 */
function readCacheFile(path: string): DiskCacheV2 | null {
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  const lastUpdated =
    typeof data.lastUpdated === "string" ? data.lastUpdated : new Date(0).toISOString();
  const models = Array.isArray(data.models) ? (data.models as Array<{ id: string }>) : [];
  const entries = Array.isArray(data.entries) ? (data.entries as SlimModelEntry[]) : [];
  const plans = Array.isArray(data.plans) ? (data.plans as CachedSubscriptionPlan[]) : undefined;
  // Read back explicitly. This function rebuilds the object from a known field
  // list rather than spreading `data`, so any field not named here is silently
  // dropped on the way in — which is what happened to `catalogRevision` until
  // a round-trip check caught it writing correctly and reading back undefined.
  const catalogRevision =
    typeof data.catalogRevision === "string" ? data.catalogRevision : undefined;

  return {
    version: 2,
    lastUpdated,
    entries,
    models,
    ...(plans !== undefined ? { plans } : {}),
    ...(catalogRevision !== undefined ? { catalogRevision } : {}),
  };
}

/**
 * Write the cache to disk in v2 format, preserving any existing `entries`
 * or `models` the caller did not explicitly supply.
 *
 * This is the critical anti-clobber behavior: legacy writers that only know
 * about `models` will merge on top of the existing v2 `entries`, leaving the
 * OpenRouter Firebase catalog intact.
 *
 * @param data Partial DiskCacheV2. Any omitted fields are filled from the
 *             existing file (if present) rather than reset to defaults.
 * @param path Override the cache path. Defaults to `ALL_MODELS_CACHE_PATH`.
 *             Only tests should pass this.
 */
export function writeAllModelsCache(
  data: Partial<DiskCacheV2>,
  path: string = ALL_MODELS_CACHE_PATH
): void {
  // Ungated on purpose — see readCacheFile.
  const existing = readCacheFile(path);

  const merged: DiskCacheV2 = {
    version: 2,
    lastUpdated: data.lastUpdated ?? new Date().toISOString(),
    entries: data.entries ?? existing?.entries ?? [],
    models: data.models ?? existing?.models ?? [],
    ...(data.plans !== undefined || existing?.plans !== undefined
      ? { plans: data.plans ?? existing?.plans ?? [] }
      : {}),
    // Carried, never merged from `existing`. The revision describes the entries
    // and plans written in THIS call; inheriting the previous file's value onto
    // a partial write would stamp new data with an old snapshot's identity and
    // make the coherence claim a lie.
    ...(data.catalogRevision !== undefined ? { catalogRevision: data.catalogRevision } : {}),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged), "utf-8");
}
