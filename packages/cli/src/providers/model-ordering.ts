/**
 * Shared model-ordering comparator.
 *
 * **The rule:** freshness (newest release date first) is the DEFAULT display
 * order for any list of models shown to a user. Where a different order is
 * semantically required (relevance for a search, a backend-curated priority
 * for the recommendations doc), that order stays PRIMARY and this comparator
 * is applied as the TIEBREAK.
 *
 * This lives in `providers/` rather than `model-selector.ts` because both
 * `model-loader.ts` and `mcp-server.ts` need it:
 *   - `model-selector.ts` imports `model-loader.ts`, so a comparator hosted in
 *     the selector would make `model-loader -> model-selector -> model-loader`
 *     a genuine import cycle.
 *   - `mcp-server.ts` would otherwise pull the inquirer-driven picker (and its
 *     whole TUI dependency tree) into the MCP stdio path.
 *
 * `model-selector.ts` re-exports `compareByReleaseDateDesc` so existing
 * importers (cli.ts) keep working unchanged.
 */

/**
 * Extract the leading numeric version parts from a model id.
 * `"gpt-5.6-sol"` → `[5, 6]`, `"claude-opus-4-5"` → `[4, 5]`, `"grok"` → `[]`.
 */
export function extractVersionParts(modelId: string): number[] {
  const tokens = modelId.toLowerCase().split(/[\/_-]+/);
  let started = false;
  const parts: number[] = [];

  for (const token of tokens) {
    const match = token.match(/\d+(?:\.\d+)*/);
    if (!match) {
      if (started) break;
      continue;
    }

    // A PARAMETER COUNT is not a version. `120b` in `gpt-oss-120b-medium` is
    // 120 billion parameters, but read as a version it outranks every model
    // ever shipped and pins that row to the top of the picker.
    //
    // Only checked BEFORE a version has been found: once `started` is true the
    // loop's own `^\d{1,2}(\.\d+)?$` guard already rejects these, which is why
    // `llama-3.3-70b-instruct` -> [3,3] and `qwen3-235b-a22b` -> [3] are
    // already right. The bug is confined to ids where the count comes FIRST.
    //
    // The bound matters: `\d+b` alone would also swallow a legitimate `4b`, and
    // sizes below ~11B are indistinguishable from version numbers by shape. A
    // model with no other numeric token then parses as [] and sorts with the
    // unversioned names, which is the honest answer — it has no stated version.
    if (!started && /^\d+b$/.test(token) && Number.parseInt(match[0], 10) > 10) {
      continue;
    }

    if (!started) {
      started = true;
      for (const part of match[0].split(".")) {
        parts.push(Number.parseInt(part, 10));
      }

      if (!/^\d+(?:\.\d+)*$/.test(token)) {
        break;
      }

      continue;
    }

    if (!/^\d{1,2}(?:\.\d+)?$/.test(token)) {
      break;
    }

    for (const part of token.split(".")) {
      parts.push(Number.parseInt(part, 10));
    }
  }

  return parts;
}

/** Compare two version-part arrays, highest version first. Missing parts sort last. */
export function compareVersionPartsDesc(a: number[], b: number[]): number {
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i++) {
    const aPart = a[i] ?? -1;
    const bPart = b[i] ?? -1;
    if (aPart !== bPart) {
      return bPart - aPart;
    }
  }
  return 0;
}

/**
 * Compare two records by `releaseDate` (desc), then by version-parts in id
 * (desc), then by id (asc). Records without a `releaseDate` default to epoch 0,
 * and since the comparison is descending they sort AFTER every dated record —
 * undated models fall to the bottom, ordered among themselves by version then
 * id. Used by every list/picker that shows models so the newest is at the top.
 *
 * Accepts anything shaped `{ releaseDate?, id?, modelId? }`, which covers
 * `ModelInfo`, `ModelDoc`, `RecommendedModelEntry` and the OpenRouter raw model
 * shape (via a small projection — see `mcp-server.ts` `orderingKey`).
 */
export function compareByReleaseDateDesc(
  a: { releaseDate?: string; id?: string; modelId?: string },
  b: { releaseDate?: string; id?: string; modelId?: string }
): number {
  const aReleaseRaw = a.releaseDate ? Date.parse(a.releaseDate) : 0;
  const bReleaseRaw = b.releaseDate ? Date.parse(b.releaseDate) : 0;
  const aRelease = Number.isNaN(aReleaseRaw) ? 0 : aReleaseRaw;
  const bRelease = Number.isNaN(bReleaseRaw) ? 0 : bReleaseRaw;
  if (aRelease !== bRelease) {
    return bRelease - aRelease;
  }

  const aId = a.id ?? a.modelId ?? "";
  const bId = b.id ?? b.modelId ?? "";
  const versionCompare = compareVersionPartsDesc(
    extractVersionParts(aId),
    extractVersionParts(bId)
  );
  if (versionCompare !== 0) {
    return versionCompare;
  }
  return aId.localeCompare(bId);
}
