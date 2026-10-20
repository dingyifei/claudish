// Advisor auth mode — how a CLAUDE panel model behind `--advisor` is signed.
//
// `api-key` (default): upstream behaviour. A Claude panel member goes to
// OpenRouter (or, as the collector, api.anthropic.com with ANTHROPIC_API_KEY);
// the Claude Code OAuth bearer is never used.
//
// `subscription` (explicit opt-in, `--advisor-auth subscription` or
// CLAUDISH_ADVISOR_AUTH=subscription): a Claude panel member is called on
// api.anthropic.com as a REPLAY of the Claude Code request that consumed the
// advisor call — its own system array, tools and auth headers, forwarded
// untouched — so it bills to the user's Claude subscription. This mirrors the
// classifier passthrough (classifier-passthrough.ts), which forwards the
// inbound Claude Max OAuth for the auto-mode classifier. Anthropic's consumer
// terms may not permit requests claudish builds itself to use a subscription
// login; the startup notice says so on every launch that turns it on.
//
// Dependency-light (only a type import) like classifier-passthrough.ts, so
// claude-runner, advisor-startup and the proxy can all read it without cycles.

import type { ClaudishConfig } from "./types.js";

export type AdvisorAuthMode = NonNullable<ClaudishConfig["advisorAuth"]>;

export const ADVISOR_AUTH_ENV_VAR = "CLAUDISH_ADVISOR_AUTH";

/** The accepted spellings, or null for anything else. */
export function parseAdvisorAuth(value: string | undefined): AdvisorAuthMode | null {
  const v = value?.trim().toLowerCase();
  if (v === "api-key" || v === "apikey" || v === "api") return "api-key";
  if (v === "subscription" || v === "oauth") return "subscription";
  return null;
}

export interface AdvisorAuthResolution {
  mode: AdvisorAuthMode;
  /** Set when the env var holds a value `parseAdvisorAuth` rejects; startup refuses on it. */
  invalidEnvValue?: string;
}

/**
 * Flag beats env; neither → `api-key`. The flag is validated when it is parsed
 * (cli.ts), so only the env var can arrive malformed here.
 */
export function resolveAdvisorAuth(
  config: Pick<ClaudishConfig, "advisorAuth">,
  env: NodeJS.ProcessEnv = process.env
): AdvisorAuthResolution {
  if (config.advisorAuth) return { mode: config.advisorAuth };
  const raw = env[ADVISOR_AUTH_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return { mode: "api-key" };
  const parsed = parseAdvisorAuth(raw);
  return parsed ? { mode: parsed } : { mode: "api-key", invalidEnvValue: raw };
}

/**
 * True when `--advisor` is on AND the subscription mode was chosen. The mode
 * alone does nothing: without `--advisor` there is no panel to sign.
 */
export function advisorSubscriptionEnabled(
  config: Pick<ClaudishConfig, "advisor" | "advisorAuth">,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(config.advisor) && resolveAdvisorAuth(config, env).mode === "subscription";
}
