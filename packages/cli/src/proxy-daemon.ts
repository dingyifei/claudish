/**
 * Persistent proxy daemon.
 *
 * Normally claudish runs its translation proxy *in-process* and tears it down
 * when the launcher exits. That kills routing for any Claude Code session that
 * outlives the launcher (e.g. one detached via Claude Code's background-session
 * feature) — it reverts to the raw `claude-opus-*` tier on native Anthropic auth.
 *
 * When `--persist-proxy` is set, the launcher instead spawns a DETACHED daemon
 * process running the same `createProxyServer`, points Claude Code at it, and
 * leaves it running on exit. The daemon self-terminates on an idle timeout and
 * can be stopped explicitly with `claudish proxy stop`.
 *
 * Secrets are not written to disk or argv: the daemon inherits the launcher's
 * `process.env` (provider API keys flow through it) and re-reads its own
 * credential files (`~/.claudish/codex-oauth.json`, Anthropic OAuth). Only
 * non-secret config travels as a serialized argv blob; a resolved Anthropic key,
 * if any, is handed over via a private env var (never argv).
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initLogger } from "./logger.js";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

/** Internal flag marking a `claudish` invocation as "run the daemon body". */
export const DAEMON_FLAG = "--proxy-daemon";

/** Private env var carrying a resolved Anthropic key to the daemon (off argv). */
const DAEMON_ANTHROPIC_KEY_ENV = "CLAUDISH_DAEMON_ANTHROPIC_KEY";

/** A running daemon's on-disk record, one JSON file per port. */
export interface DaemonRecord {
  pid: number;
  port: number;
  url: string;
  /** secret-free summary of what it routes (e.g. "cx@gpt-5.6-sol"). */
  model: string;
  /** epoch ms. */
  startedAt: number;
  /** pid of the launcher that spawned it (informational). */
  launcherPid: number;
}

type ModelMap = { opus?: string; sonnet?: string; haiku?: string; subagent?: string };

/** Non-secret config serialized into the daemon's argv. */
export interface DaemonConfig {
  port: number;
  model?: string;
  monitorMode?: boolean;
  modelMap?: ModelMap;
  summarizeTools?: boolean;
  quiet?: boolean;
  isInteractive?: boolean;
  advisorModels?: string[];
  advisorCollector?: string | null;
  /** Pinned candidate chain from a `--model a+b+c` spec, so the daemon builds the
   *  same FallbackHandler the in-process proxy would. */
  modelChain?: string[];
  classifier?: { enabled: boolean; model: string };
  /** `--effort-override`: pinned effort level, forwarded verbatim (v7.67.0). */
  effortOverride?: string;
  /** `--model-params`: extra payload params; plain JSON, survives argv. */
  modelParams?: Record<string, unknown>;
  /** `--pro-on-ultracode`: apply the catalog pro preset during ultracode. */
  proOnUltracode?: boolean;
  idleTimeoutMs: number;
  launcherPid: number;
}

/** What the launcher passes to spawnProxyDaemon (config + optional secret). */
export interface SpawnDaemonInput extends DaemonConfig {
  /** Resolved Anthropic key, if any. Handed over via env, never argv/disk. */
  anthropicApiKey?: string;
}

// ---------------------------------------------------------------------------
// Registry (~/.claudish/proxies/<port>.json)
// ---------------------------------------------------------------------------

function defaultBaseDir(): string {
  return join(homedir(), ".claudish", "proxies");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function recordPath(port: number, baseDir = defaultBaseDir()): string {
  return join(baseDir, `${port}.json`);
}

/** True if a process with this pid exists and we can signal it. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function writeDaemonRecord(rec: DaemonRecord, baseDir = defaultBaseDir()): void {
  ensureDir(baseDir);
  writeFileSync(recordPath(rec.port, baseDir), JSON.stringify(rec, null, 2));
}

export function removeDaemonRecord(port: number, baseDir = defaultBaseDir()): void {
  try {
    unlinkSync(recordPath(port, baseDir));
  } catch {
    // Already gone — nothing to do.
  }
}

/** Read every record file verbatim (no liveness filtering). */
export function readDaemonRecords(baseDir = defaultBaseDir()): DaemonRecord[] {
  if (!existsSync(baseDir)) return [];
  const out: DaemonRecord[] = [];
  for (const name of readdirSync(baseDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(baseDir, name), "utf-8")) as DaemonRecord;
      if (rec && typeof rec.pid === "number" && typeof rec.port === "number") out.push(rec);
    } catch {
      // Skip garbled files rather than failing the whole listing.
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * Live daemons only. Prunes records whose pid is dead (stale after a crash or
 * SIGKILL that skipped cleanup), deleting their files as a side effect.
 */
export function listDaemons(baseDir = defaultBaseDir()): DaemonRecord[] {
  const live: DaemonRecord[] = [];
  for (const rec of readDaemonRecords(baseDir)) {
    if (isPidAlive(rec.pid)) live.push(rec);
    else removeDaemonRecord(rec.port, baseDir);
  }
  return live;
}

// ---------------------------------------------------------------------------
// Model summary
// ---------------------------------------------------------------------------

function modelSummary(model?: string, modelMap?: ModelMap): string {
  return modelMap?.opus || model || modelMap?.sonnet || modelMap?.haiku || "(native)";
}

// ---------------------------------------------------------------------------
// Launcher side: spawn a detached daemon
// ---------------------------------------------------------------------------

/** Command + arg prefix to re-invoke *this* claudish (script or compiled binary). */
function selfInvocation(): { cmd: string; prefix: string[] } {
  const scriptPath = process.argv[1];
  if (scriptPath && existsSync(scriptPath)) {
    // Running from a JS entrypoint under bun/node.
    return { cmd: process.execPath, prefix: [scriptPath] };
  }
  // Compiled standalone binary — execPath IS claudish.
  return { cmd: process.execPath, prefix: [] };
}

async function pollHealth(url: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/__claudish/health`);
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Spawn the proxy as a detached, launcher-independent daemon and wait until it
 * is serving. Returns a ProxyServer-shaped object whose `shutdown()` is a no-op
 * (the daemon is meant to outlive the launcher), so the launcher's existing
 * finally/signal flow leaves it running.
 */
export async function spawnProxyDaemon(input: SpawnDaemonInput): Promise<ProxyServer> {
  const { anthropicApiKey, ...cfg } = input;
  const url = `http://127.0.0.1:${cfg.port}`;

  const { cmd, prefix } = selfInvocation();
  const args = [...prefix, DAEMON_FLAG, JSON.stringify(cfg)];

  const env = { ...process.env };
  if (anthropicApiKey) env[DAEMON_ANTHROPIC_KEY_ENV] = anthropicApiKey;

  const child = spawn(cmd, args, { detached: true, stdio: "ignore", env });
  child.unref();

  const ready = await pollHealth(url);
  if (!ready) {
    try {
      if (child.pid) process.kill(child.pid);
    } catch {
      // best-effort
    }
    throw new Error(`Persistent proxy daemon failed to start on ${url} within timeout`);
  }

  return daemonProxyHandle(cfg.port);
}

/**
 * The launcher-side `ProxyServer` handle for a proxy that lives in ANOTHER
 * process. Every member is a stand-in: the launcher can neither stop the
 * daemon (it must outlive the launcher by design) nor reach into its caches
 * or counters. Exported so the contract is testable without spawning.
 */
export function daemonProxyHandle(port: number): ProxyServer {
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    // Intentionally a no-op: the daemon must survive launcher exit. Use
    // `claudish proxy stop` (or the idle timeout) to terminate it.
    shutdown: async () => {},
    // The daemon has its own handler caches; the launcher can't reach into
    // another process, so this is a no-op for the persistent path.
    invalidateHandlerCache: () => {},
    // The counter lives in the daemon process; the launcher cannot read it.
    // -1 means "unknown" and deliberately fails index.ts's `=== 0` test, so
    // daemon mode never claims Claude Code contacted no model.
    modelRequestCount: () => -1,
  };
}

// ---------------------------------------------------------------------------
// Daemon side: run the proxy body
// ---------------------------------------------------------------------------

/**
 * If argv marks this as a daemon invocation, return the serialized config blob;
 * otherwise null. Called from the top-level dispatch in index.ts.
 */
export function daemonConfigFromArgv(argv: string[]): string | null {
  const i = argv.indexOf(DAEMON_FLAG);
  if (i === -1) return null;
  return argv[i + 1] ?? "{}";
}

/**
 * Daemon entry point. Starts the proxy with an idle timeout, records itself in
 * the registry, and installs teardown handlers. Never returns while serving —
 * the HTTP server keeps the event loop alive.
 */
export async function runProxyDaemon(configJson: string): Promise<void> {
  // The daemon is spawned detached with `stdio: "ignore"`, so its fd 1/2 are
  // /dev/null: every console.* and every logStderr() vanishes. It also never
  // reaches runCli(), which is the only other place initLogger() is called — so
  // without this the file logger is inert too and the daemon has NO diagnostic
  // channel at all. A routing error, a failed credential refresh, or the
  // classifier tripwire would each fail completely silently.
  try {
    initLogger(false, "info", false);
  } catch {
    // A logger that cannot start must not stop the proxy from serving.
  }

  let cfg: DaemonConfig;
  try {
    cfg = JSON.parse(configJson) as DaemonConfig;
  } catch (err) {
    console.error(`[claudish-daemon] invalid config: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const anthropicApiKey = process.env[DAEMON_ANTHROPIC_KEY_ENV];
  const summary = modelSummary(cfg.model, cfg.modelMap);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    removeDaemonRecord(cfg.port);
  };

  let proxy: ProxyServer;
  try {
    proxy = await createProxyServer(
      cfg.port,
      undefined,
      cfg.model,
      cfg.monitorMode ?? false,
      anthropicApiKey,
      cfg.modelMap,
      {
        summarizeTools: cfg.summarizeTools,
        quiet: cfg.quiet,
        isInteractive: cfg.isInteractive,
        advisorModels: cfg.advisorModels,
        advisorCollector: cfg.advisorCollector,
        modelChain: cfg.modelChain,
        classifier: cfg.classifier,
        effortOverride: cfg.effortOverride,
        modelParams: cfg.modelParams,
        proOnUltracode: cfg.proOnUltracode,
        idleTimeoutMs: cfg.idleTimeoutMs,
        onIdleTimeout: () => {
          cleanup();
          process.exit(0);
        },
      }
    );
  } catch (err) {
    console.error(
      `[claudish-daemon] failed to start proxy on port ${cfg.port}: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  writeDaemonRecord({
    pid: process.pid,
    port: proxy.port,
    url: proxy.url,
    model: summary,
    startedAt: Date.now(),
    launcherPid: cfg.launcherPid,
  });

  // Explicit stop (`claudish proxy stop`) sends SIGTERM: shut down cleanly.
  process.on("SIGTERM", () => {
    void proxy.shutdown().finally(() => {
      cleanup();
      process.exit(0);
    });
  });
  // A closing terminal sends SIGHUP to its process group; the daemon must
  // ignore it (detached: true already puts it in a new group, but a no-op
  // handler is belt-and-suspenders against inherited-group edge cases).
  process.on("SIGHUP", () => {});
  // Best-effort record removal on any other exit path.
  process.on("exit", cleanup);
}
