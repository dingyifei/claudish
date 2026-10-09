/**
 * `claudish providers --json` — non-interactive credential-presence report.
 *
 * The claude-desktop-profiles app uses this to annotate the model catalog with
 * "configured on this machine" vs. not. It needs to know WHICH providers have
 * working credentials here and WHERE those credentials come from — but never
 * the credentials themselves.
 *
 * Output (one entry per non-virtual provider):
 *   { "providers": [
 *       { "slug": "x-ai",   "ready": true,  "authSource": "env" },
 *       { "slug": "google", "ready": false, "authSource": null }
 *   ] }
 *
 * The `slug` is the canonical BUILTIN_PROVIDERS name (catalogName) — the same
 * string `claudish serve` accepts as a pinned `provider` in its models.json,
 * and the string parseModelSpec/resolveRemoteProvider match on. (NOT the
 * TUI-facing alias: e.g. slug is "google", not the picker label "gemini".)
 *
 * SECURITY: this command emits credential PRESENCE and SOURCE only. It must
 * never include any value, masked fragment, or key material whatsoever — a
 * stricter bar than the --probe provenance path, which is allowed to show a
 * masked prefix. (--probe used to serialize the PLAINTEXT key under
 * `chain[].provenance.effectiveValue`; that field is gone — see the
 * KeyProvenance doc comment in providers/api-key-provenance.ts.)
 */

import { type CredentialSource, describeSource } from "./auth/credentials/source.js";
import { loadConfig } from "./profile-config.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { getProviderDefs } from "./tui/providers.js";

interface ProviderStatus {
  slug: string;
  ready: boolean;
  authSource: CredentialSource;
}

/**
 * Build the provider-status list.
 *
 * ASYNC because readiness is decided by the credential authority — the same
 * oracle routing and sign-time use (env → aliases → config → oauth-file →
 * 1Password). This command previously classified with the SYNC TUI helper,
 * which structurally cannot see a 1Password-only key, so every op-sourced
 * provider was reported `ready: false` and the profiles app concluded the
 * machine had no credentials at all.
 *
 * `describeSource` resolves all providers concurrently; resolution is serialized
 * behind the op queue and a 1Password Environment is fetched once per process,
 * so this is ONE handshake for the whole list rather than one per provider.
 */
export async function collectProviderStatuses(
  config: { apiKeys?: Record<string, string>; localProviders?: string[] } = loadConfig()
): Promise<ProviderStatus[]> {
  // Register runtime providers BEFORE enumerating, or this list silently omits
  // every bundled catalog row and every user `customEndpoints` entry — the
  // same "a surface enumerated providers before registration ran" defect as
  // #192, on the surface the profiles app reads. `getProviderDefs()` is called
  // rather than a module-load snapshot for the same reason.
  //
  // Called with NO argument on purpose. The `config` parameter here is a
  // deliberately narrow `{apiKeys?, localProviders?}` — it exists so the config
  // TUI can classify against an UNSAVED snapshot — and handing that to
  // registration would mean deciding the endpoint list from an object with no
  // `customEndpoints` and no `predefinedEndpoints` at all. Every user endpoint
  // would vanish and every opt-out would be ignored, silently, for any caller
  // that passed one. Registration reads the real config itself; the latch makes
  // that free on all but the first call.
  ensureEndpointsRegistered();
  return Promise.all(
    getProviderDefs().map(async (p) => {
      const authSource = await describeSource(p, config);
      return {
        // Canonical provider name — the slug the profiles app round-trips back
        // as `provider` in serve's models.json.
        slug: p.catalogName,
        ready: authSource !== null,
        authSource,
      };
    })
  );
}

export async function providersCommand(opts: { json: boolean }): Promise<void> {
  const providers = await collectProviderStatuses();

  if (opts.json) {
    // Stable, machine-readable output. No key material anywhere — only the
    // presence boolean and the source enum.
    console.log(JSON.stringify({ providers }, null, 2));
    return;
  }

  // Human-readable fallback (no --json). Still presence + source only.
  for (const p of providers) {
    const mark = p.ready ? "✓" : "·";
    const src = p.authSource ?? "—";
    console.log(`${mark} ${p.slug.padEnd(20)} ${src}`);
  }
}
