/**
 * API Key Provenance — traces where an API key comes from across all resolution layers.
 *
 * Resolution order (first non-empty wins):
 *   1. process.env (shell profile, e.g. ~/.config/env-keys.sh sourced by .zshenv)
 *   2. .env file in CWD (loaded by dotenv at startup, does NOT override existing env vars)
 *   3. ~/.claudish/config.json apiKeys (loaded at startup, does NOT override existing env vars)
 *
 * Since dotenv and config.json never override, the value in process.env at runtime
 * always comes from whichever source set it first. This module inspects all three
 * sources independently so the user can see what WOULD have been used from each layer.
 *
 * Layer 3 follows the `--config <file>` override (config-override.ts): provenance
 * must read the SAME file the credential authority resolves from, and the layer is
 * labeled with the override's real path so the UI names the file actually in play.
 *
 * VAULT-HYDRATED VALUES: the macOS Keychain and 1Password both deliver their keys
 * by write-through into process.env, so by the time this inspects layer 3 they are
 * indistinguishable from a shell export. Neither can be re-read here cheaply (and
 * re-reading 1Password could prompt), so origin is recovered from the run-scoped
 * records the authority keeps — `isKeychainHydratedVar` / `isOpHydratedVar` — and
 * reported by name rather than as "shell environment".
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { isKeychainHydratedVar } from "../auth/credentials/keychain-source.js";
import { activeGlobalConfigFile, getConfigFileOverride } from "../config-override.js";
import { isOpHydratedVar } from "./onepassword.js";

/**
 * The global config file this run actually reads. Under a `--config` override
 * that is the override file, NOT the machine one — provenance must inspect the
 * same file the credential authority resolves from, or it mislabels an override
 * key as "shell environment".
 */
function activeConfigPath(): string {
  return activeGlobalConfigFile(join(homedir(), ".claudish", "config.json"));
}

/** Display label for the config layer: the real path when overridden, else the tilde form. */
function configLayerLabel(): string {
  return getConfigFileOverride() ? activeConfigPath() : "~/.claudish/config.json";
}

/**
 * A single resolution layer.
 *
 * SECURITY: `maskedValue` is the ONLY value-derived field. A raw secret must
 * never be stored here — `KeyLayer` is embedded in `KeyProvenance`, which is
 * serialized wholesale by `--probe --json`.
 */
export interface KeyLayer {
  source: string;
  maskedValue: string | null;
  isActive: boolean;
}

/**
 * Where an API key comes from — a REPORTING record, not a credential carrier.
 *
 * SECURITY: this object is serialized wholesale (`--probe --json` prints it via
 * `JSON.stringify`), so it must NEVER hold plaintext key material. It carries
 * presence (`hasValue`), a display mask (`effectiveMasked`), the env-var NAME,
 * and the source label — nothing else. Callers that genuinely need the secret
 * must read it from the credential authority (`auth/credentials/`) directly;
 * do not reintroduce a value field here under any name.
 */
export interface KeyProvenance {
  envVar: string;
  /** True when a key resolved from some layer. Presence only — never the value. */
  hasValue: boolean;
  effectiveMasked: string | null;
  effectiveSource: string;
  layers: KeyLayer[];
}

function maskKey(key: string | undefined | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "***";
  return `${key.substring(0, 8)}...`;
}

/**
 * Resolve the provenance of an API key by checking all possible sources.
 *
 * @param envVar - Primary env var name (e.g. "GEMINI_API_KEY")
 * @param aliases - Alternative env var names to check
 */
export function resolveApiKeyProvenance(envVar: string, aliases?: string[]): KeyProvenance {
  const layers: KeyLayer[] = [];
  let effectiveSource = "not set";

  // Check all env var names (primary + aliases)
  const allVars = [envVar, ...(aliases || [])];

  // Layer 1: .env file in CWD
  const dotenvValue = readDotenvKey(allVars);
  layers.push({
    source: `.env (${resolve(".env")})`,
    maskedValue: maskKey(dotenvValue),
    isActive: false, // determined below
  });

  // Layer 2: the active global config (the --config override file when set)
  const configValue = readConfigKey(envVar);
  layers.push({
    source: configLayerLabel(),
    maskedValue: maskKey(configValue),
    isActive: false,
  });

  // Layer 3: process.env (final runtime value — includes shell profile, dotenv, config.json)
  // Check aliases too
  let runtimeVar = envVar;
  let runtimeValue = process.env[envVar] || null;
  if (!runtimeValue && aliases) {
    for (const alias of aliases) {
      if (process.env[alias]) {
        runtimeVar = alias;
        runtimeValue = process.env[alias]!;
        break;
      }
    }
  }

  layers.push({
    source: `process.env[${runtimeVar}]`,
    maskedValue: maskKey(runtimeValue),
    isActive: !!runtimeValue,
  });

  // Determine which source is active
  if (runtimeValue) {
    if (dotenvValue && dotenvValue === runtimeValue) {
      effectiveSource = ".env";
      layers[0].isActive = true;
      layers[2].isActive = false;
    } else if (configValue && configValue === runtimeValue) {
      effectiveSource = configLayerLabel();
      layers[1].isActive = true;
      layers[2].isActive = false;
    } else if (isKeychainHydratedVar(runtimeVar)) {
      // In process.env, but put there by the keychain step of the credential
      // authority (or the TUI's startup hydration) — not a genuine shell export.
      // Checked BEFORE the 1Password branch because the keychain is resolved
      // first, so a variable both stores could supply was supplied by this one.
      effectiveSource = "macOS Keychain";
      layers[2].source = `process.env[${runtimeVar}] (from macOS Keychain)`;
    } else if (isOpHydratedVar(runtimeVar)) {
      // The value sits in process.env, but it was hydrated from 1Password at
      // startup (op:// ref, glob import, or Environment) — not a genuine shell
      // env var. Report the true origin so the UI doesn't mislabel it "env".
      effectiveSource = "1Password";
      layers[2].source = `process.env[${runtimeVar}] (from 1Password)`;
      // layers[2] already marked active
    } else {
      effectiveSource = "shell environment";
      // layers[2] already marked active
    }
  }

  // NOTE: `runtimeValue` stays local. It is deliberately NOT placed on the
  // returned record — see the KeyProvenance doc comment.
  return {
    envVar: runtimeVar,
    hasValue: !!runtimeValue,
    effectiveMasked: maskKey(runtimeValue),
    effectiveSource,
    layers,
  };
}

/**
 * Format provenance for debug log output (single line).
 */
export function formatProvenanceLog(p: KeyProvenance): string {
  if (!p.hasValue) {
    return `${p.envVar}=(not set)`;
  }
  return `${p.envVar}=${p.effectiveMasked} [from: ${p.effectiveSource}]`;
}

/**
 * Format provenance for --probe TUI output (multi-line with all layers).
 */
export function formatProvenanceProbe(p: KeyProvenance, indent = "    "): string[] {
  const lines: string[] = [];

  if (!p.hasValue) {
    lines.push(`${indent}${p.envVar}: not set`);
    return lines;
  }

  lines.push(`${indent}${p.envVar} = ${p.effectiveMasked}  [from: ${p.effectiveSource}]`);

  for (const layer of p.layers) {
    const marker = layer.isActive ? ">>>" : "   ";
    const value = layer.maskedValue || "(not set)";
    lines.push(`${indent}  ${marker} ${layer.source}: ${value}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readDotenvKey(envVars: string[]): string | null {
  try {
    const dotenvPath = resolve(".env");
    if (!existsSync(dotenvPath)) return null;
    const parsed = parseDotenv(readFileSync(dotenvPath, "utf-8"));
    for (const v of envVars) {
      if (parsed[v]) return parsed[v];
    }
    return null;
  } catch {
    return null;
  }
}

function readConfigKey(envVar: string): string | null {
  try {
    const configPath = activeConfigPath();
    if (!existsSync(configPath)) return null;
    const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as {
      apiKeys?: Record<string, string>;
    };
    return cfg.apiKeys?.[envVar] || null;
  } catch {
    return null;
  }
}
