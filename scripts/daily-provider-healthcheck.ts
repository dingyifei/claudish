#!/usr/bin/env bun
/**
 * daily-provider-healthcheck — is the whole stack still working, across every
 * provider and every currently-recommended model?
 *
 *   bun scripts/daily-provider-healthcheck.ts
 *   bun scripts/daily-provider-healthcheck.ts --batch 5 --dry-run
 *
 * Built to run UNATTENDED, once a day, and to stay quiet unless something is
 * actually broken. The exit code is the alert: 0 = nothing to see, 1 = a model
 * regressed or a provider broke since the last run.
 *
 * TWO LAYERS, because they fail for different reasons and cost different money.
 *
 *   Layer 1 — `claudish --probe`: one real 1-token request down each model's
 *   fallback chain. Costs ~nothing, and it is the layer that catches an expired
 *   key, a revoked OAuth grant, a provider outage, or a 4xx from a renamed
 *   endpoint. Every configured provider gets touched here.
 *
 *   Layer 2 — `claudish --team … --mode json`: real interactive Claude Code
 *   sessions in a real magmux grid, `--batch` at a time. ~27k input tokens each
 *   (Claude Code's own system prompt), so ~$0.03 a model, ~$0.21 for the current
 *   roster. This is the layer that catches what a probe cannot: a translation
 *   bug in tool-call or streaming shape that only appears once a real agent is
 *   driving the model.
 *
 * WHY THE MODEL LIST IS NOT PINNED: it is read from
 * ~/.claudish/recommended-models.json at run time. Pinning ids would turn this
 * into a snapshot of one afternoon's roster that goes red every time a vendor
 * ships, for reasons that have nothing to do with claudish. Same argument as
 * madbench/types.ts. New models are picked up on the first run after they land,
 * and the report calls out which ones are new since the previous run.
 *
 * WHY EACH MODEL IS ROUTED `or@<openrouterId>`: the bare recommended id is not
 * always resolvable by the routing rules — `nemotron-3-super-120b-a12b` matches
 * no vendor pattern and dies with `unrecognized_model` before a request is ever
 * made. The openrouterId always routes. Layer 1 still probes each model's NATIVE
 * provider chain first, so direct provider routes are not left untested.
 *
 * THE ANTI-FALLBACK ASSERTION: a session that answers correctly has not
 * necessarily used the model we asked for. Every run therefore reads the
 * per-session stats file and asserts `model_name` is the model requested.
 * Without that, a silent fallback to native Anthropic would look like a pass.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO_ROOT = resolve(import.meta.dir, "..");
const OUT_ROOT = join(REPO_ROOT, "logs", "health");
const RECOMMENDED = join(homedir(), ".claudish", "recommended-models.json");

/** The sentinel. One token of output, nothing to parse, nothing to stylise. */
const SENTINEL = "MODEL_WORKS";
const PROMPT = `Reply with exactly: ${SENTINEL} and nothing else.`;

const argv = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const BATCH = Number(flag("batch", "5"));
const PROBE_TIMEOUT = Number(flag("probe-timeout", "20"));
const DRY = argv.includes("--dry-run");

interface RecommendedModel {
  id: string;
  openrouterId?: string;
  name?: string;
  provider?: string;
}

interface ProbeLink {
  provider: string;
  displayName?: string;
  modelSpec?: string;
  hasCredentials?: boolean;
  probe?: { state?: string; latencyMs?: number; errorMessage?: string };
}

interface SessionResult {
  id: string;
  route: string;
  name: string;
  provider: string;
  state: string;
  exitCode: number | null;
  answered: boolean;
  routedModel: string | null;
  routedProvider: string | null;
  costUsd: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  /** Empty when the model passed; one line per failed expectation otherwise. */
  failures: string[];
  detail: string;
}

const nowIso = () => new Date().toISOString();
const log = (line: string) => process.stdout.write(`${line}\n`);

/** Recommended models, in the priority order the catalogue already sorts them. */
function readRecommended(): RecommendedModel[] {
  const raw = JSON.parse(readFileSync(RECOMMENDED, "utf-8"));
  const list: RecommendedModel[] = Array.isArray(raw) ? raw : (raw.models ?? []);
  return list.filter((m) => m?.id);
}

/** `or@<openrouterId>` when we have one, else the bare id and hope routing bites. */
const routeFor = (m: RecommendedModel): string =>
  m.openrouterId ? `or@${m.openrouterId}` : m.id;

/** The model id the stats file must report if nothing silently fell back. */
const expectedRoutedModel = (m: RecommendedModel): string => m.openrouterId ?? m.id;

/**
 * The `--probe` state vocabulary, ranked and classified.
 *
 * The classification is the part that matters, and it is not the obvious one.
 * `model-not-found` is a HEALTHY signal: the provider was reached, the
 * credential was accepted, and the service answered with a semantic error
 * because it does not carry the model under that name. Layer 1 probes the
 * recommended (OpenRouter-shaped) ids against every chain, so a native provider
 * legitimately not offering `kimi-k2.5` is noise — treating it as a break would
 * make this alert every single day for no reason.
 *
 * `out-of-credit` / `plan-limit` are likewise authenticated and reachable. They
 * are a billing fact about the account, not a regression in claudish, so they
 * get their own class: reported prominently, never alerted on.
 *
 * What IS a break is a transport or format failure — a 500, a 400 saying the
 * request shape was rejected, a timeout. That is the class this exists to catch.
 */
const PROBE_RANK: Record<string, number> = {
  live: 6,
  "model-not-found": 5,
  "out-of-credit": 4,
  "plan-limit": 4,
  "key-missing": 2,
};

type ProbeClass = "ok" | "billing" | "unconfigured" | "broken";

function classifyProbe(state: string): ProbeClass {
  if (state === "live" || state === "model-not-found") return "ok";
  if (state === "out-of-credit" || state === "plan-limit") return "billing";
  if (state === "key-missing") return "unconfigured";
  return "broken";
}

/**
 * Layer 1. `--probe` exits non-zero on nothing in particular, so failure is read
 * out of the chain states rather than the exit code.
 */
async function probeProviders(models: RecommendedModel[]): Promise<{
  providerStates: Record<string, { state: string; latencyMs?: number; error?: string }>;
}> {
  const ids = models.map((m) => m.id);
  log(`[probe] ${ids.length} models, ${PROBE_TIMEOUT}s per link`);
  let parsed: { model: string; nativeProvider: string; chain: ProbeLink[] }[] = [];
  try {
    const { stdout } = await run(
      "claudish",
      ["--probe", ...ids, "--json", "--probe-timeout", String(PROBE_TIMEOUT)],
      { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 }
    );
    parsed = JSON.parse(stdout);
  } catch (err) {
    log(`[probe] FAILED to run: ${(err as Error).message}`);
    return { providerStates: {} };
  }

  // One provider appears in many chains. Keep its best observed state: a
  // provider that answered for ANY model is up, whatever else it declined.
  const rank = (s?: string) => PROBE_RANK[s ?? ""] ?? 1;
  const providerStates: Record<string, { state: string; latencyMs?: number; error?: string }> = {};
  for (const entry of parsed) {
    for (const link of entry.chain ?? []) {
      const st = link.probe?.state ?? "unknown";
      const prev = providerStates[link.provider];
      if (!prev || rank(st) > rank(prev.state)) {
        providerStates[link.provider] = {
          state: st,
          latencyMs: link.probe?.latencyMs,
          error: link.probe?.errorMessage,
        };
      }
    }
  }
  return { providerStates };
}

/**
 * Layer 2, one batch. `--team` fans the batch out across a magmux grid and
 * writes its own run directory; everything below is read back out of it.
 */
async function runBatch(batch: RecommendedModel[], batchDir: string): Promise<SessionResult[]> {
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(join(batchDir, "input.md"), `${PROMPT}\n`);

  const routes = batch.map(routeFor);
  log(`[team] ${routes.join(", ")}`);

  let statusRaw = "";
  try {
    const { stdout } = await run(
      "claudish",
      ["--team", routes.join(","), "--mode", "json", "-f", "input.md"],
      { cwd: batchDir, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 }
    );
    statusRaw = stdout;
  } catch (err) {
    // A non-zero team exit still leaves a parseable status document behind.
    statusRaw = (err as { stdout?: string }).stdout ?? "";
    if (!statusRaw) {
      return batch.map((m) => ({
        id: m.id,
        route: routeFor(m),
        name: m.name ?? m.id,
        provider: m.provider ?? "?",
        state: "HARNESS_ERROR",
        exitCode: null,
        answered: false,
        routedModel: null,
        routedProvider: null,
        costUsd: null,
        totalTokens: null,
        durationMs: null,
        failures: [`team run produced no status: ${(err as Error).message}`],
        detail: (err as Error).message.slice(0, 400),
      }));
    }
  }

  let status: {
    models?: Record<string, Record<string, unknown>>;
    responses?: Record<string, string>;
  } = {};
  try {
    status = JSON.parse(statusRaw);
  } catch {
    /* fall through to the work-dir scan below */
  }

  // Slot -> model comes from the run's manifest; the grid shuffles slots, so the
  // order routes were passed in is NOT the order they come back.
  const workDir = readdirSync(batchDir).find((d) => d.startsWith(".claudish-team-"));
  const slotToModel: Record<string, string> = {};
  const statsBySlot: Record<string, Record<string, unknown>> = {};
  if (workDir) {
    const wd = join(batchDir, workDir);
    try {
      const manifest = JSON.parse(readFileSync(join(wd, "manifest.json"), "utf-8"));
      for (const [slot, v] of Object.entries<Record<string, string>>(manifest.models ?? {})) {
        slotToModel[slot] = v.model;
      }
    } catch {
      /* no manifest — slot mapping stays empty and every model reports unknown */
    }
    const statsDir = join(wd, "stats");
    if (existsSync(statsDir)) {
      for (const f of readdirSync(statsDir)) {
        try {
          statsBySlot[f.replace(/\.json$/, "")] = JSON.parse(
            readFileSync(join(statsDir, f), "utf-8")
          );
        } catch {
          /* a truncated stats file is itself a finding, handled as "no stats" */
        }
      }
    }
  }

  const slotOf = (route: string): string | undefined =>
    Object.entries(slotToModel).find(([, model]) => model === route)?.[0];

  return batch.map((m) => {
    const route = routeFor(m);
    const slot = slotOf(route);
    const entry = slot ? (status.models?.[slot] ?? {}) : {};
    const response = slot ? (status.responses?.[slot] ?? "") : "";
    const stats = slot ? (statsBySlot[slot] ?? {}) : {};

    const state = String(entry.state ?? "MISSING");
    const exitCode = typeof entry.exitCode === "number" ? entry.exitCode : null;
    const answered = response.includes(SENTINEL);
    const routedModel = (stats.model_name as string) ?? null;
    const started = entry.startedAt ? Date.parse(String(entry.startedAt)) : null;
    const done = entry.completedAt ? Date.parse(String(entry.completedAt)) : null;

    const failures: string[] = [];
    if (state !== "COMPLETED") failures.push(`session state ${state}`);
    if (exitCode !== 0) failures.push(`exit code ${exitCode ?? "none"}`);
    if (!answered) failures.push(`no ${SENTINEL} in response`);
    // The anti-fallback check. Absent stats are suspicious but not conclusive,
    // so they only fail a session that is not already failing for other reasons.
    const want = expectedRoutedModel(m);
    if (routedModel && routedModel !== want) {
      failures.push(`routed to ${routedModel}, expected ${want}`);
    } else if (!routedModel && failures.length === 0) {
      failures.push("no stats file — cannot prove which model answered");
    }

    const errDetail = (entry.error as Record<string, string> | undefined) ?? {};
    return {
      id: m.id,
      route,
      name: m.name ?? m.id,
      provider: m.provider ?? "?",
      state,
      exitCode,
      answered,
      routedModel,
      routedProvider: (stats.provider_name as string) ?? null,
      costUsd: typeof stats.total_cost === "number" ? stats.total_cost : null,
      totalTokens: typeof stats.total_tokens === "number" ? stats.total_tokens : null,
      durationMs: started && done ? done - started : null,
      failures,
      detail: (errDetail.stderrSnippet || errDetail.detail || response || "")
        .toString()
        .trim()
        .slice(0, 300),
    };
  });
}

/** The previous run's result.json, for newly-broken vs still-broken vs new-model. */
function previousRun(): {
  models?: SessionResult[];
  date?: string;
  providerStates?: Record<string, { state: string }>;
} | null {
  if (!existsSync(OUT_ROOT)) return null;
  const dirs = readdirSync(OUT_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort()
    .reverse();
  for (const d of dirs) {
    const p = join(OUT_ROOT, d, "result.json");
    if (existsSync(p)) {
      try {
        return { ...JSON.parse(readFileSync(p, "utf-8")), date: d };
      } catch {
        /* keep looking back */
      }
    }
  }
  return null;
}

function buildReport(
  sessions: SessionResult[],
  providerStates: Record<string, { state: string; latencyMs?: number; error?: string }>,
  prev: ReturnType<typeof previousRun>
): {
  markdown: string;
  broken: SessionResult[];
  newlyBroken: SessionResult[];
  brokenProviders: string[];
  newlyBrokenProviders: string[];
} {
  const broken = sessions.filter((s) => s.failures.length > 0);
  const prevById = new Map((prev?.models ?? []).map((m) => [m.id, m]));
  const newlyBroken = broken.filter((s) => {
    const before = prevById.get(s.id);
    return !before || before.failures.length === 0;
  });
  const newModels = sessions.filter((s) => prev && !prevById.has(s.id));
  const recovered = (prev?.models ?? []).filter((p) => {
    if (p.failures.length === 0) return false;
    const now = sessions.find((s) => s.id === p.id);
    return now && now.failures.length === 0;
  });

  const totalCost = sessions.reduce((a, s) => a + (s.costUsd ?? 0), 0);

  const classified = Object.entries(providerStates).map(
    ([p, v]) => [p, v, classifyProbe(v.state)] as const
  );
  const brokenProviders = classified.filter(([, , c]) => c === "broken").map(([p]) => p);
  const billingProviders = classified.filter(([, , c]) => c === "billing");
  // Only a provider that broke SINCE the last run is worth waking someone for.
  // A known-broken provider stays in the report every day without re-alerting,
  // otherwise one unfixed 400 turns the whole check into background noise.
  const newlyBrokenProviders = brokenProviders.filter(
    (p) => classifyProbe(prev?.providerStates?.[p]?.state ?? "live") !== "broken"
  );

  const L: string[] = [];
  L.push(`# claudish provider health — ${nowIso()}`);
  L.push("");
  L.push(
    broken.length === 0
      ? `All ${sessions.length} recommended models answered through a real Claude Code session.`
      : `**${broken.length} of ${sessions.length} models failed.** ${newlyBroken.length} newly broken since ${prev?.date ?? "the first run"}.`
  );
  if (brokenProviders.length) {
    L.push("");
    L.push(
      `Providers in a broken state: ${brokenProviders.join(", ")}` +
        (newlyBrokenProviders.length
          ? ` (new since ${prev?.date ?? "the first run"}: ${newlyBrokenProviders.join(", ")})`
          : " (all previously known)")
    );
  }
  L.push("");
  L.push(`Estimated cost of this run: $${totalCost.toFixed(3)}`);
  L.push("");

  L.push("## Layer 2 — real sessions");
  L.push("");
  L.push("| model | route | result | routed to | s | $ |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const s of sessions) {
    const verdict = s.failures.length === 0 ? "pass" : `FAIL — ${s.failures.join("; ")}`;
    L.push(
      `| ${s.id} | ${s.route} | ${verdict} | ${s.routedModel ?? "?"} | ${
        s.durationMs ? Math.round(s.durationMs / 1000) : "?"
      } | ${s.costUsd?.toFixed(4) ?? "?"} |`
    );
  }
  L.push("");

  L.push("## Layer 1 — provider probes (1-token live request)");
  L.push("");
  L.push("| provider | state | class | ms | note |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const [p, v, c] of [...classified].sort((a, b) => a[0].localeCompare(b[0]))) {
    L.push(`| ${p} | ${v.state} | ${c} | ${v.latencyMs ?? ""} | ${(v.error ?? "").slice(0, 80)} |`);
  }
  L.push("");

  if (brokenProviders.length) {
    L.push("## Broken providers — transport or request-format failure");
    L.push("");
    for (const p of brokenProviders) {
      const v = providerStates[p];
      L.push(
        `- **${p}**${newlyBrokenProviders.includes(p) ? " (NEW)" : ""} — ${v.state} ${v.error ?? ""}`
      );
    }
    L.push("");
  }
  if (billingProviders.length) {
    L.push("## Authenticated but billing-blocked (not a regression)");
    L.push("");
    for (const [p, v] of billingProviders) L.push(`- ${p} — ${v.state}`);
    L.push("");
  }
  if (newModels.length) {
    L.push("## New in the recommended catalogue since the last run");
    L.push("");
    for (const s of newModels)
      L.push(`- ${s.id} (${s.provider}) — ${s.failures.length === 0 ? "works" : "FAILS"}`);
    L.push("");
  }
  if (recovered.length) {
    L.push("## Recovered since the last run");
    L.push("");
    for (const s of recovered) L.push(`- ${s.id}`);
    L.push("");
  }
  if (broken.length) {
    L.push("## Failure detail");
    L.push("");
    for (const s of broken) {
      L.push(`### ${s.id} (${s.route})`);
      L.push("");
      for (const f of s.failures) L.push(`- ${f}`);
      if (s.detail) {
        L.push("");
        L.push("```");
        L.push(s.detail);
        L.push("```");
      }
      L.push("");
    }
  }
  return { markdown: L.join("\n"), broken, newlyBroken, brokenProviders, newlyBrokenProviders };
}

async function main(): Promise<void> {
  const models = readRecommended();
  if (models.length === 0) {
    log("No recommended models found — nothing to check. Treating as a failure.");
    process.exit(1);
  }

  const stamp = nowIso().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const runDir = join(OUT_ROOT, stamp);
  mkdirSync(runDir, { recursive: true });

  log(`claudish provider health — ${models.length} models, batches of ${BATCH}`);
  log(`run dir: ${runDir}`);
  if (DRY) {
    for (const m of models) log(`  would check ${m.id} via ${routeFor(m)}`);
    process.exit(0);
  }

  const { providerStates } = await probeProviders(models);

  const sessions: SessionResult[] = [];
  for (let i = 0; i < models.length; i += BATCH) {
    const batch = models.slice(i, i + BATCH);
    const n = Math.floor(i / BATCH) + 1;
    log(`[batch ${n}] ${batch.length} models`);
    sessions.push(...(await runBatch(batch, join(runDir, `batch-${n}`))));
  }

  const prev = previousRun();
  const { markdown, broken, newlyBroken, brokenProviders, newlyBrokenProviders } = buildReport(
    sessions,
    providerStates,
    prev
  );

  writeFileSync(join(runDir, "report.md"), `${markdown}\n`);
  writeFileSync(
    join(runDir, "result.json"),
    `${JSON.stringify(
      {
        finishedAt: nowIso(),
        modelCount: sessions.length,
        brokenCount: broken.length,
        newlyBrokenIds: newlyBroken.map((s) => s.id),
        brokenProviders,
        newlyBrokenProviders,
        previousRun: prev?.date ?? null,
        providerStates,
        models: sessions,
      },
      null,
      2
    )}\n`
  );

  log("");
  log(markdown);
  log("");
  log(`report: ${join(runDir, "report.md")}`);
  // The exit code is the alert. Failing sessions always alert; providers alert
  // only when they broke since the last run, so a long-standing fault does not
  // reduce this to a daily false positive.
  process.exit(broken.length > 0 || newlyBrokenProviders.length > 0 ? 1 : 0);
}

await main();
