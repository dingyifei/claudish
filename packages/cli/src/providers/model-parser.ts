/**
 * Model Parser - Unified syntax for provider@model:concurrency
 *
 * New syntax: provider@model[:concurrency]
 * Examples:
 *   openrouter@google/gemini-3-pro-preview  - Explicit OpenRouter
 *   google@gemini-3-pro-preview             - Direct Google API
 *   g@gemini-3-pro-preview                  - Direct Google API (shortcut)
 *   ollama@llama3.2:3                       - Ollama with concurrency 3
 *   ollama@llama3.2:0                       - Ollama with no limits
 *   openai/gpt-5.3                          - Legacy syntax (auto-detected)
 *
 * Provider shortcuts (case-insensitive):
 *   g, gemini     -> google (direct Gemini API)
 *   oai           -> openai (direct OpenAI API)
 *   or            -> openrouter
 *   mm, mmax      -> minimax
 *   kimi, moon    -> kimi/moonshot
 *   glm, zhipu    -> glm/zhipu
 *   z-ai, zai     -> z-ai (z.ai)
 *   x-ai, grok    -> x-ai (xAI / Grok)
 *   oc            -> ollamacloud
 *   zen           -> opencode-zen
 *   v, vertex     -> vertex
 *   ag, antigravity -> antigravity (shared OAuth token)
 *   go            -> antigravity (DEPRECATED alias — prints a notice)
 *
 * Local provider shortcuts:
 *   ollama        -> ollama (local)
 *   lms, lmstudio -> lmstudio (local)
 *   vllm          -> vllm (local)
 *   mlx           -> mlx (local)
 *
 * Native model detection (when no provider prefix):
 *   google/*, gemini-*     -> google (direct)
 *   openai/*, gpt-*, o1-*  -> openai (direct)
 *   minimax/*              -> minimax (direct)
 *   moonshot/*, kimi-*     -> kimi (direct)
 *   zhipu/*, glm-*         -> glm (direct)
 *   deepseek/*, deepseek-*  -> auto-routed (no direct API, falls to OpenRouter)
 *   x-ai/*, grok-*         -> x-ai (direct with XAI_API_KEY, else OpenRouter)
 *   qwen/*,  qwen*         -> auto-routed (no direct API, falls to OpenRouter)
 *   anthropic/*            -> native-anthropic
 *   (anything else with /) -> openrouter
 */

/**
 * Parsed model specification
 */
export interface ParsedModel {
  /** Normalized provider name (lowercase) */
  provider: string;
  /** Model name/ID (without provider prefix) */
  model: string;
  /** Original full model string */
  original: string;
  /** Concurrency limit for local providers (undefined = use default, 0 = no limit) */
  concurrency?: number;
  /** Whether this used legacy syntax (for deprecation warnings) */
  isLegacySyntax: boolean;
  /** Whether provider was explicitly specified (vs auto-detected) */
  isExplicitProvider: boolean;
}

/**
 * Provider shortcut mappings — derived from BUILTIN_PROVIDERS.
 * Re-exported for backward compatibility.
 */
import {
  getLegacyPrefixPatterns as _getLegacyPrefixPatterns,
  getNativeModelPatterns as _getNativeModelPatterns,
  getShortcuts as _getShortcuts,
  isDirectApiProvider as _isDirectApiProvider,
  isLocalTransport,
} from "./provider-definitions.js";

export const PROVIDER_SHORTCUTS: Record<string, string> = _getShortcuts();

/**
 * Local providers (no API key needed) — derived from BUILTIN_PROVIDERS.
 */
export const LOCAL_PROVIDERS = {
  has(name: string): boolean {
    return isLocalTransport(name);
  },
};

/**
 * Providers that support direct API access — derived from BUILTIN_PROVIDERS.
 */
export const DIRECT_API_PROVIDERS = {
  has(name: string): boolean {
    return _isDirectApiProvider(name);
  },
};

/**
 * Native model prefixes — derived from BUILTIN_PROVIDERS.
 */
export const NATIVE_MODEL_PATTERNS = _getNativeModelPatterns();

/**
 * Legacy prefix patterns — derived from BUILTIN_PROVIDERS.
 */
export const LEGACY_PREFIX_PATTERNS = _getLegacyPrefixPatterns();

/**
 * Separator for a ROUTE CHAIN — an ordered list of explicit specs to try in turn:
 *
 *   zgo@minimax-m2.5+mm@MiniMax-M2.5+or@minimax/minimax-m2.5
 *
 * Why a chain form exists at all: `team` and channel `create_session` spawn child
 * claudish processes with an EXPLICIT spec rather than the bare name, because a
 * bare name makes the child re-resolve credentials and open its own 1Password SDK
 * client — and that handshake is arbitrated machine-wide, so N children racing it
 * means N-1 denials or N sequential dialogs (see `auth/credentials/prehydrate.ts`).
 * Explicitness is what buys one dialog per run. But an explicit spec is also a
 * chain of ONE, so those children had no fallback: `isRetryableError` is reachable
 * only from `FallbackHandler`, which is only built for a name the child routes
 * itself. A spent subscription, a rotated key, or a capability rejection killed the
 * model outright, where the same request served interactively would have fallen
 * through. This form carries the parent's whole chain across the process boundary
 * with every element still explicit, so both properties hold at once.
 *
 * `+` rather than `,` (already the advisor/team list separator) or `|` (needs shell
 * quoting when a user copies a spawn line out of a log). Verified against the live
 * catalog: 0 of 764 model ids contain a `+`.
 */
export const MODEL_CHAIN_SEPARATOR = "+";

/**
 * Split a `--model` value into its ordered candidates.
 *
 * A string with no separator yields a one-element array, so callers can treat
 * every model value as a chain without branching. Empty segments are dropped —
 * a trailing separator is a formatting artifact, not a request for a null
 * candidate.
 */
export function parseModelChain(modelSpec: string): string[] {
  const parts = modelSpec
    .split(MODEL_CHAIN_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [modelSpec];
}

/**
 * Parse a model specification string
 *
 * Supports both new and legacy syntax:
 * - New: provider@model[:concurrency]
 * - Legacy: prefix/model or prefix:model
 *
 * NOTE: this parses ONE spec. A chain value (`a+b+c`) must be split with
 * {@link parseModelChain} first — the CLI does that at the argument boundary, so
 * everything downstream of arg parsing still sees a single spec.
 *
 * @param modelSpec - The model specification string
 * @returns Parsed model information
 */
export function parseModelSpec(modelSpec: string): ParsedModel {
  const original = modelSpec;

  // Check for URL-style model (http:// or https://)
  if (modelSpec.startsWith("http://") || modelSpec.startsWith("https://")) {
    return {
      provider: "custom-url",
      model: modelSpec,
      original,
      isLegacySyntax: false,
      isExplicitProvider: true,
    };
  }

  // Check for new @ syntax: provider@model[:concurrency]
  const atMatch = modelSpec.match(/^([^@]+)@(.+)$/);
  if (atMatch) {
    const providerPart = atMatch[1].toLowerCase();
    let modelPart = atMatch[2];
    let concurrency: number | undefined;

    // Check for concurrency suffix on local providers
    const concurrencyMatch = modelPart.match(/^(.+):(\d+)$/);
    if (concurrencyMatch) {
      modelPart = concurrencyMatch[1];
      concurrency = Number.parseInt(concurrencyMatch[2], 10);
    }

    // Resolve provider shortcut
    const provider = PROVIDER_SHORTCUTS[providerPart] || providerPart;

    return {
      provider,
      model: modelPart,
      original,
      concurrency,
      isLegacySyntax: false,
      isExplicitProvider: true,
    };
  }

  // Check for legacy prefix patterns
  const lowerSpec = modelSpec.toLowerCase();
  for (const { prefix, provider, stripPrefix } of LEGACY_PREFIX_PATTERNS) {
    if (lowerSpec.startsWith(prefix)) {
      const model = stripPrefix ? modelSpec.slice(prefix.length) : modelSpec;

      // Check for concurrency suffix on local providers
      let concurrency: number | undefined;
      let modelName = model;
      if (LOCAL_PROVIDERS.has(provider)) {
        const concurrencyMatch = model.match(/^(.+):(\d+)$/);
        if (concurrencyMatch) {
          modelName = concurrencyMatch[1];
          concurrency = Number.parseInt(concurrencyMatch[2], 10);
        }
      }

      return {
        provider,
        model: modelName,
        original,
        concurrency,
        isLegacySyntax: true,
        isExplicitProvider: true,
      };
    }
  }

  // No explicit provider - try to detect native provider from model name
  for (const { pattern, provider } of NATIVE_MODEL_PATTERNS) {
    if (pattern.test(modelSpec)) {
      // For patterns that match "provider/model", strip the provider prefix
      const slashIndex = modelSpec.indexOf("/");
      const model = slashIndex > 0 ? modelSpec.slice(slashIndex + 1) : modelSpec;

      return {
        provider,
        model,
        original,
        isLegacySyntax: false,
        isExplicitProvider: false,
      };
    }
  }

  // Unknown vendor/model format - require explicit provider
  // Use openrouter@vendor/model if you want OpenRouter
  if (modelSpec.includes("/")) {
    return {
      provider: "unknown",
      model: modelSpec,
      original,
      isLegacySyntax: false,
      isExplicitProvider: false,
    };
  }

  // No "/" - treat as native Anthropic model
  return {
    provider: "native-anthropic",
    model: modelSpec,
    original,
    isLegacySyntax: false,
    isExplicitProvider: false,
  };
}

/**
 * Check if a provider is a local provider
 */
export function isLocalProviderName(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Check if a provider supports direct API access
 */
export function isDirectApiProvider(provider: string): boolean {
  return DIRECT_API_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Get deprecation warning for legacy syntax
 */
export function getLegacySyntaxWarning(parsed: ParsedModel): string | null {
  if (!parsed.isLegacySyntax) {
    return null;
  }

  const newSyntax = `${parsed.provider}@${parsed.model}`;
  return (
    `Deprecation warning: "${parsed.original}" uses legacy prefix syntax.\n` +
    `  Consider using: ${newSyntax}`
  );
}

/**
 * Format a model spec in the new syntax
 */
export function formatModelSpec(provider: string, model: string, concurrency?: number): string {
  let spec = `${provider}@${model}`;
  if (concurrency !== undefined) {
    spec += `:${concurrency}`;
  }
  return spec;
}
