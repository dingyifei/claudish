/**
 * Split an OpenAI-shaped `usage` object's `prompt_tokens` into the three
 * Anthropic input counters.
 *
 * `prompt_tokens` is the FULL context the provider billed for. OpenAI-compatible
 * providers report the cached portion of it as a SUBSET, under
 * `prompt_tokens_details`, and claudish previously discarded that detail
 * entirely — so every turn looked uncached to both the client and the cost
 * accounting.
 *
 * ## Field names: observed, never invented
 *
 * Only two keys are read, and both appear verbatim in captures committed to
 * `test-fixtures/sse-responses/`:
 *
 *   - `cached_tokens`      — xAI (`grok-4.6-openai-advisor-turn1.sse`:
 *                            `prompt_tokens: 20379`, `cached_tokens: 20352`)
 *                            and OpenRouter.
 *   - `cache_write_tokens` — OpenRouter's cache-CREATION counter
 *                            (`gemini-3.1-pro-or-maxtokens-*.sse`). Plain OpenAI
 *                            does not report cache writes at all, so this is 0
 *                            for most providers, which is correct: nothing was
 *                            written.
 *
 * A provider that spells either differently reports 0 here, and 0 is the
 * pre-change behaviour exactly — the split degrades to "all of it is ordinary
 * input", never to a wrong number.
 *
 * ## The invariant every consumer depends on
 *
 *   inputTokens + cacheReadTokens + cacheCreationTokens === promptTokens
 *
 * Claude Code re-derives the conversation size by summing those three
 * (verified against the client binary, 2.1.273:
 * `function FRn(e){return e.input_tokens+e.cache_creation_input_tokens+e.cache_read_input_tokens}`,
 * used by the auto-compaction threshold and the context meter). A split whose
 * parts do not add back up therefore moves the client's idea of how full the
 * context is — which is the failure mode `message-start-usage.ts` documents.
 * The clamps below exist to hold the invariant against a provider that reports a
 * cached count larger than the prompt it belongs to.
 */

export interface PromptTokenSplit {
  /** The full context size — `prompt_tokens`, unchanged. NEVER the reduced value. */
  promptTokens: number;
  /** Uncached, freshly-read input: `promptTokens - cacheRead - cacheCreation`. */
  inputTokens: number;
  /** Tokens served from the provider's prompt cache. */
  cacheReadTokens: number;
  /** Tokens written INTO the provider's prompt cache this turn. */
  cacheCreationTokens: number;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Derive the three-way split from a provider `usage` object. Safe on `null`,
 * `undefined` and anything that is not an object: it runs on the stream's
 * closing path, where refusing to produce a number would cost the turn's
 * accounting entirely.
 */
export function splitPromptTokens(usage: unknown): PromptTokenSplit {
  const u = (usage ?? {}) as Record<string, unknown>;
  const promptTokens = nonNegativeInt(u.prompt_tokens);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;

  // Clamped against the prompt, then against what is left, so the three parts
  // always sum back to `promptTokens` however the provider's numbers disagree.
  const cacheReadTokens = Math.min(nonNegativeInt(details.cached_tokens), promptTokens);
  const cacheCreationTokens = Math.min(
    nonNegativeInt(details.cache_write_tokens),
    promptTokens - cacheReadTokens
  );

  return {
    promptTokens,
    inputTokens: promptTokens - cacheReadTokens - cacheCreationTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}
