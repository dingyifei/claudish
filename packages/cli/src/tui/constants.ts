/**
 * Shared constants for the TUI. Extracted from App.tsx so both the keyboard
 * handler (App.tsx) and the render components can import them.
 */

import { getProviderDefs } from "./providers.js";

// Common models offered as autocomplete suggestions in the profile editor.
export const COMMON_MODELS = [
  "g@gemini-3.1-pro-preview",
  "g@gemini-2.5-flash",
  "g@gemini-2.5-pro",
  "oai@gpt-4o",
  "oai@gpt-4o-mini",
  "oai@o3-mini",
  "or@anthropic/claude-sonnet-4-20250514",
  "mm@minimax-m2.5",
  "kimi@kimi-k2.5",
  "glm@glm-5",
  "zen@glm-5",
  "zen@minimax-m2.5-free",
  "ll@gemini-2.5-flash",
  "ll@gpt-4o",
  "or@google/gemini-3.1-pro-preview",
  "or@x-ai/grok-code-fast-1",
  "or@deepseek/deepseek-r1",
];

/**
 * Provider prefix suggestions for the provider picker (e.g. "g@", "oai@", ...).
 *
 * A FUNCTION, not a const, for the same reason `getProviderDefs()` is: a
 * module-load snapshot is taken before `ensureEndpointsRegistered()` runs, so
 * it can never contain a provider registered at runtime — a bundled catalog row
 * or one of the user's own `customEndpoints`. That is exactly the defect #192
 * describes, and a `const` here would keep one corner of it alive after the
 * rest was fixed.
 */
export function getProviderPrefixes(): Array<{
  prefix: string;
  displayName: string;
  name: string;
}> {
  return getProviderDefs().map((p) => ({
    prefix: p.aliases?.[0] ? `${p.aliases[0]}@` : `${p.name}@`,
    displayName: p.displayName,
    name: p.name,
  }));
}

/**
 * Chain selector — same provider list as the prefix picker, so the two never disagree
 * about which providers exist. A function for the same reason
 * `getProviderPrefixes()` is: a const would freeze the list before runtime
 * registration.
 */
export function getChainProviders(): ReturnType<typeof getProviderDefs> {
  return getProviderDefs();
}

// Layout constants — header(2) + tab-bar(3) + content(flex) + detail(fixed) + footer(1).
// Header is 2 rows: the title/version/profile text, plus a bottom-border rule.
export const HEADER_H = 2;
export const TABS_H = 3;
export const FOOTER_H = 1;
export const DETAIL_H = 7;
