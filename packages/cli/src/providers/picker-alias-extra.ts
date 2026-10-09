/**
 * Extra `@prefix` spellings that are NOT registered provider shortcuts.
 *
 * The alias table proper is DERIVED (see `getProviderFilterAliases` in
 * `model-selector.ts`) from each definition's canonical name plus its
 * `shortcuts` — the strings claudish already accepts on the command line, so
 * `@dv` filters there exactly as `dv@model` routes. These few are picker-only
 * conveniences with no definition behind them.
 *
 * It lives in its own dependency-free module because two callers need it and
 * they have very different weight classes: the picker (which owns it) and the
 * predefined-endpoint collision check, which runs on every startup path and
 * must not drag `model-selector.ts`'s prompt/catalog import graph in behind it.
 * A collision guard that is expensive to consult is a collision guard someone
 * eventually moves to CI only — which is exactly the finding that put this
 * table inside the runtime check in the first place.
 */
export const PROVIDER_FILTER_ALIAS_EXTRA: Record<string, string> = {
  gem: "google",
  // Legacy picker value for OpenCode Zen; the provider list now uses the definition
  // name, and both still resolve downstream.
  zen: "opencode-zen",
};
