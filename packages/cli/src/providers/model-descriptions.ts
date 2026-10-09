/**
 * providers/model-descriptions.ts — one prose sentence per model, indexed by id
 * and by alias.
 *
 * WHY THIS FILE EXISTS AT ALL. The old inquirer picker printed a model's
 * description under the highlighted row — "Kimi's most capable model to date,
 * with 2.8 trillion parameters…" — and that sentence is the only thing on the
 * screen that says what a model IS rather than what it costs. The OpenTUI picker
 * lost it, because its list is built from the SLIM catalog and the slim payload
 * carries no `description`: 0 of 704 entries on disk have one, and
 * `model-catalog.ts:servedByVendor` records that gap as the price of reading the
 * served-by index locally. `catalogModelToModelInfo` therefore substitutes
 * `"<provider> model"`, which is a placeholder, not a description.
 *
 * THE RICH ENDPOINT HAS THEM AND IT IS ONE REQUEST. MEASURED 2026-09-10 against
 * the live catalog: `?status=active&limit=1500` returns all 1016 active models in
 * 2.8 s / 1.06 MB, and 978 of them carry a description (p50 180 characters).
 * Everything else in that payload is already known locally, so only the
 * projection is kept — id, aliases, description — which is what makes a daily
 * disk cache cheap enough to be worth having.
 *
 * IT NEVER BLOCKS A LIST. The caller starts this beside the rows rather than in
 * front of them: the picker paints from the slim index immediately and the
 * detail line fills in when this lands. A description is worth waiting for on the
 * selected row and worth nothing at all on a row nobody has looked at.
 *
 * IT NEVER THROWS. Every failure — offline, a 500, an unparseable body, an
 * unwritable cache dir — resolves to whatever index it already had, because a
 * missing sentence must never be able to take the picker down.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "../logger.js";
import { getAllModelDocs } from "../model-loader.js";
import { FIREBASE_CACHE_TTL_MS } from "./cache-ttl.js";

/** Firebase-derived data — OK to cache locally per the catalog policy. */
export const MODEL_DESCRIPTIONS_CACHE_PATH = join(
  homedir(),
  ".claudish",
  "model-descriptions.json"
);

interface DescriptionCache {
  version: 1;
  lastUpdated: string;
  /** `modelId` → description. Aliases are expanded on read, not stored twice. */
  byId: Record<string, string>;
  /** `alias` → `modelId`. Kept apart so an alias cannot shadow a real id. */
  aliases: Record<string, string>;
}

/**
 * The index the picker reads. Lookup is case-insensitive on the id, because a
 * row's id comes from the slim catalog and an alias from a dynamic models catalog, and the
 * two do not agree about case (`GLM-4.6` vs `glm-4.6`).
 */
export interface DescriptionIndex {
  get(modelId: string): string | undefined;
  /** How many models carry a sentence. Zero means "not loaded yet", never "none exist". */
  readonly size: number;
}

const EMPTY_INDEX: DescriptionIndex = { get: () => undefined, size: 0 };

/** The empty index, as a named value, so a caller's "not loaded yet" reads as intent. */
export function emptyDescriptionIndex(): DescriptionIndex {
  return EMPTY_INDEX;
}

function indexFrom(cache: DescriptionCache): DescriptionIndex {
  const byId = new Map<string, string>();
  for (const [id, text] of Object.entries(cache.byId)) byId.set(id.toLowerCase(), text);
  for (const [alias, id] of Object.entries(cache.aliases)) {
    const text = cache.byId[id];
    if (text !== undefined && !byId.has(alias.toLowerCase())) byId.set(alias.toLowerCase(), text);
  }
  return {
    get: (modelId: string) => byId.get(modelId.toLowerCase()),
    size: Object.keys(cache.byId).length,
  };
}

function readCache(path: string): DescriptionCache | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<DescriptionCache>;
    if (!raw || typeof raw !== "object" || typeof raw.byId !== "object" || raw.byId === null) {
      return null;
    }
    return {
      version: 1,
      lastUpdated:
        typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date(0).toISOString(),
      byId: raw.byId as Record<string, string>,
      aliases: (raw.aliases ?? {}) as Record<string, string>,
    };
  } catch {
    return null;
  }
}

function writeCache(path: string, cache: DescriptionCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf-8");
  } catch (e: unknown) {
    // A read-only home is not a reason to have no descriptions this session.
    log(`[model-descriptions] cache write failed: ${(e as Error)?.message ?? String(e)}`);
  }
}

function isFresh(cache: DescriptionCache): boolean {
  const age = Date.now() - new Date(cache.lastUpdated).getTime();
  return Number.isFinite(age) && age >= 0 && age <= FIREBASE_CACHE_TTL_MS;
}

/** One in-process promise: a picker with two views must not fetch this twice. */
let _inflight: Promise<DescriptionIndex> | null = null;

/**
 * The description index — fresh cache, else one bulk fetch, else the stale cache.
 *
 * THE STALE CACHE IS PREFERRED TO NOTHING. A description is editorial text about a
 * model that already exists; a day-old sentence is right, and an absent one is the
 * defect this file was written to fix.
 */
export async function loadModelDescriptions(
  path: string = MODEL_DESCRIPTIONS_CACHE_PATH
): Promise<DescriptionIndex> {
  if (_inflight) return _inflight;
  _inflight = (async (): Promise<DescriptionIndex> => {
    const cached = readCache(path);
    if (cached && isFresh(cached)) {
      log(`[model-descriptions] ${Object.keys(cached.byId).length} descriptions from disk cache`);
      return indexFrom(cached);
    }
    const started = Date.now();
    try {
      const docs = await getAllModelDocs();
      const byId: Record<string, string> = {};
      const aliases: Record<string, string> = {};
      for (const doc of docs) {
        const text = (doc.description ?? "").trim();
        if (text === "") continue;
        byId[doc.modelId] = text;
        for (const alias of doc.aliases ?? []) {
          if (alias !== doc.modelId && aliases[alias] === undefined) aliases[alias] = doc.modelId;
        }
      }
      const fresh: DescriptionCache = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        byId,
        aliases,
      };
      writeCache(path, fresh);
      log(
        `[model-descriptions] fetched ${docs.length} models, ${Object.keys(byId).length} with a description, in ${Date.now() - started} ms`
      );
      return indexFrom(fresh);
    } catch (e: unknown) {
      log(
        `[model-descriptions] fetch failed after ${Date.now() - started} ms: ${(e as Error)?.message ?? String(e)}`
      );
      return cached ? indexFrom(cached) : EMPTY_INDEX;
    }
  })();
  return _inflight;
}

/** Test seam: drop the in-process memo so a second call re-reads. */
export function _resetModelDescriptions(): void {
  _inflight = null;
}
