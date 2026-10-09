/**
 * Ollama local model discovery.
 *
 * Ollama exposes installed models at `GET {host}/api/tags` and per-model
 * capabilities at `POST {host}/api/show`. This module is the single shared
 * fetcher used by both the `--list` footer (cli.ts) and the interactive model
 * picker (model-selector.ts) so the two never drift.
 *
 * Network-light and fail-soft: every fetch is wrapped in a short timeout and
 * any error resolves to an empty list, so a missing/unreachable daemon never
 * throws — callers fall back to free-text entry. The one caller that needs to
 * TELL the user the daemon is down rather than absorb it passes
 * `throwOnError: true`; see that option.
 */

export interface OllamaModel {
  /** Prefixed id for routing, e.g. `ollama/llama3.2:3b`. */
  id: string;
  /** Bare model name as Ollama knows it, e.g. `llama3.2:3b`. */
  name: string;
  description: string;
  provider: "ollama";
  pricing: { prompt: string; completion: string };
  isLocal: true;
  supportsTools: boolean;
  isEmbeddingModel: boolean;
  capabilities: string[];
  details?: unknown;
  size?: number;
}

/** Resolve the Ollama base URL, honoring OLLAMA_HOST / OLLAMA_BASE_URL. */
export function ollamaBaseUrl(): string {
  return process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
}

interface FetchOllamaOptions {
  /**
   * When true (default), fall back to `POST /api/show` for any model whose
   * `/api/tags` row carried no `capabilities` array — one extra request per
   * such model. Pass false to skip that and accept the silence.
   *
   * Ollama publishes `capabilities` inline in `/api/tags` (verified against a
   * live daemon, 2026-09-23: every one of 20 installed models carried it), so
   * on a current daemon this fallback never fires and the fan-out costs
   * nothing. It stays for older daemons, which omit the field.
   */
  enrichCapabilities?: boolean;
  /**
   * Re-throw a daemon failure instead of absorbing it into `[]`.
   *
   * Default `false`, so every existing caller is byte-identical. Opt in only
   * when you can report the difference: "the daemon is not running" and "the
   * daemon is running and nothing is pulled" are the same `[]` otherwise, and
   * model discovery used to record both as `empty-models-catalog` — telling the user
   * their local provider serves no models when in fact nothing answered.
   */
  throwOnError?: boolean;
}

/**
 * Fetch installed Ollama models. Returns `[]` when the daemon is unreachable,
 * returns an error, or has no models — never throws unless `throwOnError` is
 * set. Embedding models are filtered out (they can't be used for
 * chat/completion).
 */
export async function fetchOllamaModels(options: FetchOllamaOptions = {}): Promise<OllamaModel[]> {
  const { enrichCapabilities = true, throwOnError = false } = options;
  const host = ollamaBaseUrl();

  try {
    const response = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      if (throwOnError) throw new Error(`HTTP ${response.status} from ${host}/api/tags`);
      return [];
    }

    const data = (await response.json()) as { models?: Array<Record<string, any>> };
    const models = data.models || [];

    const enriched = await Promise.all(
      models.map(async (m) => {
        // `/api/tags` publishes `capabilities` inline on a current daemon, so
        // ask the list before spending a request per model on `/api/show`.
        let capabilities: string[] = Array.isArray(m.capabilities) ? m.capabilities : [];

        if (enrichCapabilities && capabilities.length === 0) {
          try {
            const showResponse = await fetch(`${host}/api/show`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: m.name }),
              signal: AbortSignal.timeout(2000),
            });
            if (showResponse.ok) {
              const showData = (await showResponse.json()) as { capabilities?: string[] };
              capabilities = showData.capabilities || [];
            }
          } catch {
            // Ignore capability-fetch errors — the model stays undescribed, and
            // that is reported rather than guessed at from its name.
          }
        }

        const supportsTools = capabilities.includes("tools");
        // Ollama'"'"'s own word, and only Ollama'"'"'s word. This used to read
        // `|| nameLower.includes("embed")`, which is the same class of guess as
        // the deleted NON_CHAT_PATTERNS: it hides any model whose name happens to
        // contain "embed" and misses every embedding model that does not say so.
        // A daemon that reports nothing leaves `capabilities` empty, which reads
        // as "not stated" everywhere downstream.
        const isEmbeddingModel = capabilities.includes("embedding");
        const sizeInfo = m.details?.parameter_size || "unknown size";
        const toolsIndicator = supportsTools ? "✓ tools" : "✗ no tools";

        return {
          id: `ollama/${m.name}`,
          name: m.name as string,
          description: `Local Ollama model (${sizeInfo}, ${toolsIndicator})`,
          provider: "ollama" as const,
          pricing: { prompt: "0", completion: "0" },
          isLocal: true as const,
          supportsTools,
          isEmbeddingModel,
          capabilities,
          details: m.details,
          size: m.size,
        };
      })
    );

    return enriched.filter((m) => !m.isEmbeddingModel);
  } catch (err) {
    // Ollama not running or not reachable.
    if (throwOnError) throw err;
    return [];
  }
}
