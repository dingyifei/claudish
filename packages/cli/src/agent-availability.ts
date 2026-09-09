import { spawn } from "node:child_process";

/**
 * Is a `--agent` name real?
 *
 * WHY THIS EXISTS. Claude Code validates `--agent` and fails loudly with the list
 * of valid names — but NOT under `--input-format stream-json`, where an unknown
 * name is silently ignored and the session runs the DEFAULT agent instead.
 * Measured 2026-08-22, one variable between the two runs:
 *
 *   claude … --output-format stream-json --input-format stream-json --agent zzz-bogus
 *     → exit 0, nothing on stderr, default agent silently used
 *   claude … --output-format stream-json                            --agent zzz-bogus
 *     → exit 1, "--agent 'zzz-bogus' not found. Available agents: …"
 *
 * The channel transport (`create_session`) spawns with `--input-format stream-json`,
 * so a typo there — `agent: "dev:reviwer"` — produces a plausible answer from the
 * wrong agent with nothing anywhere saying so. That is a failure that reports itself
 * as a success, which is the exact defect class the `require_pattern` work exists to
 * kill. `team` is unaffected (it spawns `--stdin`), but validating centrally covers
 * both and keeps them from drifting.
 */

/** A name no real agent can hold, used to make Claude Code print its roster. */
const PROBE_AGENT = "__claudish_agent_probe__";

/** How long a discovered roster stays fresh. Plugins can be installed mid-session. */
const TTL_MS = 5 * 60_000;

interface Entry {
  agents: Set<string>;
  at: number;
}

/**
 * Keyed by cwd — NOT global. The roster is resolved relative to the working
 * directory: measured from this repo it is 24 names including every plugin agent,
 * and from /tmp it is 5. Caching globally would reject valid agents for one
 * directory because another had a narrower roster.
 */
const cache = new Map<string, Entry>();

/** Extract the roster from Claude Code's rejection message. Null if absent. */
export function parseAvailableAgents(output: string): string[] | null {
  const m = /Available agents:\s*(.+)/.exec(output);
  if (!m) return null;
  const names = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

/** Run the probe. Resolves to null when the roster cannot be determined. */
async function probe(cwd: string): Promise<Set<string> | null> {
  return new Promise((resolveP) => {
    let out = "";
    let settled = false;
    const done = (v: Set<string> | null) => {
      if (!settled) {
        settled = true;
        resolveP(v);
      }
    };
    try {
      // `-p` with a bogus agent fails on ARGUMENT validation before any model
      // work — measured at ~0.5s, no API call, no tokens.
      const child = spawn("claude", ["--agent", PROBE_AGENT, "-p"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(null);
      }, 15_000);
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        out += d;
      });
      child.on("error", () => {
        clearTimeout(timer);
        done(null);
      });
      child.on("close", () => {
        clearTimeout(timer);
        const names = parseAvailableAgents(out);
        done(names ? new Set(names) : null);
      });
      // MUST end stdin: `-p` reads it, and an unclosed pipe hangs forever.
      child.stdin.end("probe\n");
    } catch {
      done(null);
    }
  });
}

/** The roster for `cwd`, or null when it cannot be determined. Cached per cwd. */
export async function discoverAvailableAgents(cwd: string): Promise<Set<string> | null> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.agents;
  const agents = await probe(cwd);
  if (agents) cache.set(cwd, { agents, at: Date.now() });
  return agents;
}

/** Test seam — drop cached rosters. */
export function clearAgentCache(): void {
  cache.clear();
}

/**
 * Test seam — supply the roster for `cwd` instead of probing.
 *
 * Exists because the accept/reject behaviour is the whole point of this module
 * and cannot otherwise be tested without spawning a real `claude`: a suite that
 * only covers "no agent named" and "roster undeterminable" would stay green if
 * this file became a no-op. Seeding the cache is deliberately used rather than
 * mocking the module — a Bun `mock.module` on shared infrastructure bleeds into
 * sibling test files.
 */
export function seedAgentCacheForTest(cwd: string, agents: string[]): void {
  cache.set(cwd, { agents: new Set(agents), at: Date.now() });
}

/**
 * Throw if `agent` is not a real agent in `cwd`.
 *
 * FAILS OPEN when the roster cannot be determined (claude not on PATH, probe
 * timed out, output shape changed). Blocking every session because a probe broke
 * would be a worse failure than the one this guards, and it mirrors the contract
 * `prehydrateCredentialsForSpawn` already documents: a resolution step is an
 * optimisation of WHERE something is checked, not a gate on whether the spawn
 * proceeds.
 */
export async function assertAgentAvailable(agent: string | undefined, cwd: string): Promise<void> {
  if (!agent) return;
  const available = await discoverAvailableAgents(cwd);
  if (!available) return; // fail open — see above
  if (available.has(agent)) return;
  const known = [...available].sort().join(", ");
  throw new Error(
    `Unknown agent '${agent}'. Available agents: ${known}. ` +
      "Claude Code silently ignores an unknown --agent under the channel transport " +
      "(--input-format stream-json) and runs the DEFAULT agent instead, so this is " +
      "rejected here rather than producing a plausible answer from the wrong agent."
  );
}
