/**
 * Auto-update checker for Claudish
 *
 * Checks npm registry for new versions and shows a notification.
 * Caches the check result to avoid checking on every run (once per day).
 * This is notification-only — actual updates are done via `claudish update`.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { cliAnsi } from "./theme/ansi.js";

const isWindows = platform() === "win32";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/claudish/latest";

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  lastCheck: number;
  latestVersion: string | null;
}

/**
 * Get cache file path
 * Uses platform-appropriate cache directory:
 * - Windows: %LOCALAPPDATA%\claudish or %USERPROFILE%\AppData\Local\claudish
 * - Unix/macOS: ~/.cache/claudish
 */
function getCacheFilePath(): string {
  let cacheDir: string;

  if (isWindows) {
    // Windows: Use LOCALAPPDATA or fall back to AppData\Local
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    cacheDir = join(localAppData, "claudish");
  } else {
    // Unix/macOS: Use ~/.cache/claudish
    cacheDir = join(homedir(), ".cache", "claudish");
  }

  try {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    return join(cacheDir, "update-check.json");
  } catch {
    // Fall back to temp directory if home cache fails
    return join(tmpdir(), "claudish-update-check.json");
  }
}

/**
 * Read cached update check result
 */
function readCache(): UpdateCache | null {
  try {
    const cachePath = getCacheFilePath();
    if (!existsSync(cachePath)) {
      return null;
    }
    const data = JSON.parse(readFileSync(cachePath, "utf-8"));
    return data as UpdateCache;
  } catch {
    return null;
  }
}

/**
 * Write update check result to cache
 */
function writeCache(latestVersion: string | null): void {
  try {
    const cachePath = getCacheFilePath();
    const data: UpdateCache = {
      lastCheck: Date.now(),
      latestVersion,
    };
    writeFileSync(cachePath, JSON.stringify(data), "utf-8");
  } catch {
    // Silently fail - caching is optional
  }
}

/**
 * Check if cache is still valid (less than 24 hours old)
 */
function isCacheValid(cache: UpdateCache): boolean {
  const age = Date.now() - cache.lastCheck;
  return age < CACHE_MAX_AGE_MS;
}

/**
 * Clear the update cache (called after successful update)
 */
export function clearCache(): void {
  try {
    const cachePath = getCacheFilePath();
    if (existsSync(cachePath)) {
      unlinkSync(cachePath);
    }
  } catch {
    // Silently fail
  }
}

/**
 * Semantic version comparison
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, "").split(".").map(Number);
  const parts2 = v2.replace(/^v/, "").split(".").map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

export interface FetchVersionOptions {
  /** Per-attempt timeout. Default 5s (the background check must not stall startup). */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 0. */
  retries?: number;
}

/**
 * Fetch latest version from npm registry, throwing a descriptive error on failure.
 *
 * Callers that want to report *why* the check failed use this; `fetchLatestVersion`
 * wraps it for the fire-and-forget startup notification. Registry latency here is
 * spiky (sub-200ms when warm, multiple seconds on a cold DNS/TLS handshake), so an
 * aggressive timeout with no retry turns a slow network into a hard failure.
 */
export async function fetchLatestVersionOrThrow(
  options: FetchVersionOptions = {}
): Promise<string> {
  const { timeoutMs = 5000, retries = 0 } = options;
  let lastError: Error = new Error("unknown error");

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(NPM_REGISTRY_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`npm registry returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as { version?: string };
      if (!data.version) {
        throw new Error("npm registry response contained no version field");
      }
      return data.version;
    } catch (error) {
      // AbortError means our own timeout fired — say so, rather than blaming the network.
      lastError =
        error instanceof Error && error.name === "AbortError"
          ? new Error(`request timed out after ${timeoutMs}ms`)
          : error instanceof Error
            ? error
            : new Error(String(error));
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

/**
 * Fetch latest version from npm registry. Returns null on any failure.
 */
export async function fetchLatestVersion(
  options: FetchVersionOptions = {}
): Promise<string | null> {
  try {
    return await fetchLatestVersionOrThrow(options);
  } catch {
    // Network error, timeout, or parsing error - silently fail
    return null;
  }
}

/**
 * Resolve the newest published version, preferring the 24-hour cache.
 *
 * The single place that decides "does this run hit npm?", shared by the startup
 * notification, the interactive update prompt, and `--version`. A failed fetch
 * is cached as `null` too, so an offline machine does not retry the registry on
 * every invocation.
 *
 * @param options - Fetch timeout/retries. Used only on a cache miss.
 */
export async function getLatestVersionCached(
  options: FetchVersionOptions = {}
): Promise<string | null> {
  const cache = readCache();
  if (cache && isCacheValid(cache)) {
    return cache.latestVersion;
  }

  const latestVersion = await fetchLatestVersion(options);
  // Cache even a null result, so a failed check does not repeat on every run.
  writeCache(latestVersion);
  return latestVersion;
}

/**
 * Is `latestVersion` a real upgrade over `currentVersion`? Null-safe, so a
 * caller can pass the result of a check that did not complete.
 */
export function isUpgrade(latestVersion: string | null, currentVersion: string): boolean {
  if (!latestVersion) return false;
  return compareVersions(latestVersion, currentVersion) > 0;
}

/**
 * The one-line "Update available" notice, as a string.
 *
 * Returned rather than printed so `--version` can put it on stdout beside the
 * version it describes, while startup keeps it on stderr with the rest of the
 * launcher chatter.
 */
export function formatUpdateNotice(
  currentVersion: string,
  latestVersion: string,
  options: { hint?: boolean } = {}
): string {
  const { hint = true } = options;
  // Resolved here, not at module load: theme detection runs at CLI startup,
  // after this module is imported.
  const { RESET, BOLD, GREEN, CYAN, DIM } = cliAnsi();
  // Suppressed when the caller is about to ask "Update now?" \u2014 telling the user
  // to run a command we are one keystroke from running is noise.
  const runHint = hint ? `   ${DIM}Run:${RESET} ${BOLD}${CYAN}claudish update${RESET}` : "";
  return `  ${CYAN}\u250c${RESET} ${BOLD}Update available:${RESET} ${currentVersion} ${DIM}\u2192${RESET} ${GREEN}${latestVersion}${RESET}${runHint}`;
}

/**
 * Check for updates and show notification
 *
 * Uses a cache to avoid checking npm on every run (once per 24 hours).
 * This is notification-only — it does not auto-update or prompt. The interactive
 * launcher calls `checkForUpdatesInteractive` (update-prompt.ts) instead, which
 * offers to run the update; this stays for non-prompting callers.
 *
 * @param currentVersion - Current installed version
 * @param options - Configuration options
 */
export async function checkForUpdates(
  currentVersion: string,
  options: {
    quiet?: boolean;
  } = {}
): Promise<void> {
  const { quiet = false } = options;

  const latestVersion = await getLatestVersionCached();
  if (!latestVersion || !isUpgrade(latestVersion, currentVersion)) {
    // Up to date, or the check could not complete — either way, stay silent.
    return;
  }

  // New version available — show single-line notification
  if (!quiet) {
    console.error("");
    console.error(formatUpdateNotice(currentVersion, latestVersion));
    console.error("");
  }
}
