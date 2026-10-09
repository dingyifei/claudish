// Functional check: does each catalog-dependent claudish function produce what the
// LIVE v3 catalog says it should? Runs the source build's own functions, in the state
// every 9.7.x user is in after one launch (contract sentinel present).
//
// Run: bun run ai-docs/reports/VERIFY_claudish_functions_vs_v3-20260919.ts
//
// Hermetic for the machine: the real sentinel is COPIED to a temp path and claudish is
// pointed at the copy; refresh writes to a temp cache. The real ~/.claudish/all-models.json
// is only read, exactly as claudish reads it.
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "claudish-fn-verify-"));
const realSentinel = join(homedir(), ".claudish", "catalog-incompatible.json");
const sentinelCopy = join(tmp, "catalog-incompatible.json");
// VERIFY_WITHOUT_SENTINEL=1 reproduces a 9.6.x user, or one whose sentinel is gone:
// claudish then reads the v2 cache frozen at the cutover instead of refusing it.
if (existsSync(realSentinel) && process.env.VERIFY_WITHOUT_SENTINEL !== "1") copyFileSync(realSentinel, sentinelCopy);
process.env.CLAUDISH_CATALOG_INCOMPATIBLE_PATH = sentinelCopy;

// VERIFY_SRC points the check at another build's source, e.g. a PR's worktree.
const src = process.env.VERIFY_SRC ?? "../../packages/cli/src";
console.log(`source under test: ${src}`);
const cc = await import(`${src}/providers/catalog-client.js`);
const mc = await import(`${src}/adapters/model-catalog.js`);
const rr = await import(`${src}/providers/routing-rules.js`);
const pc = await import(`${src}/providers/probe-catalog.js`);
// The 9.7 guard module; a v3 reader may have removed it.
const compat: any = await import(`${src}/providers/catalog-compatibility.js`).catch(() => ({ SUPPORTED_CONTRACT_VERSION: "(module removed)" }));

// ── the truth: the live v3 generation ────────────────────────────────────────
const BASE = "https://us-central1-claudish-6da10.cloudfunctions.net";
const ACCEPT = "application/vnd.models-index.catalog+json;version=3";
const get = async (p: string) => (await fetch(`${BASE}/${p}`, { headers: { Accept: ACCEPT } })).json() as Promise<any>;
const models: any[] = [];
let cursor: string | undefined;
let gen = "";
do {
  const q = new URLSearchParams({ limit: "200", status: "all", includeRouteVariants: "true" });
  if (cursor) q.set("cursor", cursor);
  const b = await get(`queryModels?${q}`);
  gen ||= b.generationId;
  models.push(...b.data.models);
  cursor = b.data.nextCursor ?? undefined;
} while (cursor);
const plans: any[] = (await get(`queryPlans?generationId=${gen}`)).data.plans;
const probes = (await get(`probeModels?generationId=${gen}`)).data;
const byId = new Map(models.map((m) => [m.modelId, m]));
// 9.7.x names the Token Plan provider qwen-cloud; the v3 reader renames it qwen-token-plan.
const TOKEN = process.env.VERIFY_TOKEN_PLAN_PROVIDER ?? "qwen-cloud";

// claudish provider for each v3 binding (ai-docs/reports/PLAN_catalog_v3_reader-20260919.md)
const BIND: Record<string, string[]> = {
  "anthropic/claude-code-subscription": ["native-anthropic"], "cognition/devin-subscription": ["devin"],
  "deepseek/direct-api": ["deepseek"], "fireworks/gateway": ["fireworks"], "google/antigravity-subscription": ["antigravity"],
  "google/direct-api": ["google"], "minimax/coding-plan-subscription": ["minimax-coding"], "minimax/direct-api": ["minimax"],
  "mistralai/direct-api": ["mistralai"], "moonshotai/direct-api": ["kimi"], "moonshotai/kimi-code-subscription": ["kimi-coding"],
  "ollama/cloud": ["ollamacloud"], "openai/codex-subscription": ["openai-codex"], "openai/direct-api": ["openai"],
  "opencode/go-subscription": ["opencode-zen-go"], "opencode/zen": ["opencode-zen"], "openrouter/gateway": ["openrouter"],
  "poe/gateway": ["poe"], "qwen/dashscope-direct": ["qwen-payg"], "qwen/modelstudio-coding-plan": ["qwen-coding"],
  "qwen/qwencloud-token-plan": ["qwen-cloud", "qwen-token-plan"], "sakana/direct-api": ["sakana"], "sakana/fugu-subscription": ["sakana-subscription"],
  "together-ai/gateway": ["together"], "vertex/google-cloud": ["vertex"], "x-ai/direct-api": ["x-ai"],
  "x-ai/supergrok-subscription": ["grok-subscription"], "z-ai/direct-api": ["z-ai", "glm"], "z-ai/glm-coding-subscription": ["glm-coding"],
};
// A wire id lives in one of TWO places: a model connection (aggregators[]), or a
// subscription plan's inclusion. Subscriptions such as the GLM Coding Plan publish
// NO model connections at all, only inclusions — reading connections alone would
// call the model by its canonical id and get it wrong.
//
// Every id v3 publishes for (model, provider). There can be several: OpenRouter lists
// both the exact id and a "~vendor/…-latest" moving pointer. Any published id is a
// valid call; the exact one is what a pinned model should use.
const wiresFor = (modelId: string, provider: string) => {
  const ids = new Set<string>();
  for (const a of byId.get(modelId)?.aggregators ?? []) {
    if (a.routeStatus === "mapped" && (BIND[`${a.route.routeId}/${a.route.routeProfileId}`] ?? []).includes(provider)) ids.add(a.externalModelId);
  }
  for (const p of plans) {
    if (!p.route || !(BIND[`${p.route.routeId}/${p.route.routeProfileId}`] ?? []).includes(provider)) continue;
    for (const i of p.inclusions ?? []) if ((i.resolution?.modelId ?? i.modelId) === modelId && i.externalModelId) ids.add(i.externalModelId);
  }
  return [...ids];
};
// A provider serves a model if it has a mapped connection OR its plan lists the model.
const providersFor = (modelId: string) => {
  const s = new Set<string>();
  for (const a of byId.get(modelId)?.aggregators ?? []) if (a.routeStatus === "mapped") for (const p of BIND[`${a.route.routeId}/${a.route.routeProfileId}`] ?? []) s.add(p);
  for (const planId of byId.get(modelId)?.subscriptionPlanIds ?? []) {
    const p = plans.find((x) => x.id === planId);
    if (p?.route) for (const prov of BIND[`${p.route.routeId}/${p.route.routeProfileId}`] ?? []) s.add(prov);
  }
  return [...s].sort();
};

type Row = { area: string; case: string; v3: string; claudish: string; ok: boolean };
const rows: Row[] = [];
const row = (area: string, c: string, v3: unknown, got: unknown, ok: boolean) =>
  rows.push({ area, case: c, v3: String(v3), claudish: String(got), ok });
const safe = async <T,>(f: () => T | Promise<T>): Promise<T | string> => {
  try {
    return await f();
  } catch (e) {
    return `THROWS ${(e as Error).name}: ${(e as Error).message.split("\n")[0].slice(0, 90)}`;
  }
};

// ── 1. reading the catalog ───────────────────────────────────────────────────
// VERIFY_SKIP_REFRESH=1 (with VERIFY_WITHOUT_SENTINEL=1) models a 9.6.x user: no guard,
// so no refresh ever records the 426, and every function reads the frozen v2 cache.
const refresh: any =
  process.env.VERIFY_SKIP_REFRESH === "1"
    ? { kind: "skipped (9.6.x: the 426 is a generic http_error)" }
    : await safe(() => cc.refreshCatalog(15000, { cachePath: join(tmp, "all-models.json") }));
row("read", "refreshCatalog()", `${models.length} models, ${plans.length} plans, generation ${gen}`, JSON.stringify(refresh), refresh?.kind === "refreshed");
row("read", "contract version this build reads", 3, compat.SUPPORTED_CONTRACT_VERSION, compat.SUPPORTED_CONTRACT_VERSION === 3 || refresh?.kind === "refreshed");
// Every plan member must exist as a model row the build can look up.
if (Array.isArray(await safe(() => cc.getCatalogEntries()))) {
  const have = new Set((cc.getCatalogEntries() as any[]).map((e) => e.modelId));
  const missing: string[] = [];
  for (const p of plans) for (const i of p.inclusions ?? []) {
    const id = i.resolution?.modelId ?? i.modelId;
    if (id && !have.has(id)) missing.push(`${p.id}:${id}`);
  }
  row("read", "every plan member has a model row", "0 missing", `${missing.length} missing${missing.length ? ": " + missing.slice(0, 8).join(", ") : ""}`, missing.length === 0);
}
const entries: any = await safe(() => cc.getCatalogEntries());
row("read", "getCatalogEntries()", `${models.length} entries`, Array.isArray(entries) ? `${entries.length} entries` : JSON.stringify(entries)?.slice(0, 100), Array.isArray(entries) && entries.length > 0);

// ── 2. wire-id translation (explicit provider@model) ─────────────────────────
for (const [model, provider] of [
  ["kimi-k3", "kimi-coding"], ["kimi-k3", "ollamacloud"], ["minimax-m3", "minimax"], ["minimax-m3", "minimax-coding"],
  ["glm-5.3-flash", "glm-coding"], ["deepseek-v4.1-flash", "deepseek"], ["grok-4.20", "x-ai"], ["claude-opus-4-5", "openrouter"],
  ["deepseek-v4.1-flash", "opencode-zen-go"], ["deepseek-v4.1-flash", TOKEN],
] as const) {
  const want = wiresFor(model, provider);
  const got: any = await safe(() => cc.resolveExternalId(model, provider));
  row("translate", `${provider}@${model}`, want.join(" or ") || "(not served)", got ?? "null → sends input unchanged", want.length === 0 ? true : want.includes(got));
}

// ── 3. bare-name routing: which providers v3 publishes vs the chain claudish builds ──
// route() filters by the credentials THIS process holds, so the chain is compared for
// correctness, not completeness: every hop must be a provider v3 says serves the model,
// called with the wire id v3 publishes for that provider.
for (const model of ["kimi-k3", "glm-5.3", "minimax-m3", "deepseek-v4.1-flash", "qwen3.8-max", "gpt-6-astra"]) {
  const plan: any = await safe(() => rr.route(model));
  const want = providersFor(model);
  if (typeof plan === "string" || plan?.kind !== "ok") {
    row("route", `bare ${model}`, want.join(",") || "(none)", typeof plan === "string" ? plan : JSON.stringify(plan).slice(0, 110), false);
    continue;
  }
  const hops = [plan.primary, ...(plan.fallbacks ?? [])];
  const wrong: string[] = [];
  const shown = hops.map((h: any) => {
    const wire = String(h.modelSpec).includes("@") ? String(h.modelSpec).split("@").slice(1).join("@") : String(h.modelSpec);
    const expected = wiresFor(model, h.provider);
    if (!want.includes(h.provider)) wrong.push(`${h.provider} does not serve it in v3, yet is sent ${wire}`);
    else if (expected.length && !expected.includes(wire)) wrong.push(`${h.provider} sends ${wire}, v3 says ${expected.join(" or ")}`);
    else if (wire.startsWith("~") && expected.some((x) => !x.startsWith("~"))) wrong.push(`${h.provider} sends the moving pointer ${wire}, not the exact ${expected.find((x) => !x.startsWith("~"))}`);
    return `${h.provider}:${wire}`;
  });
  row("route", `bare ${model}`, want.join(","), `${shown.join(" > ")}${wrong.length ? "  WRONG: " + wrong.join("; ") : ""}`, wrong.length === 0);
}

// ── 4. subscription coverage: does the plan cover the model? ────────────────
for (const [model, provider, planId] of [
  ["kimi-k3", "kimi-coding", "kimi-code"], ["gpt-6-astra", "openai-codex", "openai-codex"],
  ["glm-5.3-flash", "glm-coding", "z-ai-glm-coding-plan"], ["qwen3.8-max", TOKEN, "alibaba-token-plan-individual"],
  ["deepseek-v4.1-flash", "opencode-zen-go", "opencode-go"],
] as const) {
  const member = (byId.get(model)?.subscriptionPlanIds ?? []).includes(planId);
  const got: any = await safe(() => mc.resolveSubscriptionRouting(model, provider));
  row("coverage", `${provider} covers ${model}`, member ? `serves (${planId})` : "not a member", JSON.stringify(got), member ? got?.kind === "serves" : got?.kind !== "serves");
}

// ── 5. model metadata ────────────────────────────────────────────────────────
for (const model of ["kimi-k3", "gpt-6-astra", "qwen3.8-max"]) {
  const m = byId.get(model);
  const got: any = await safe(() => mc.lookupModel(model));
  row("metadata", `${model} context window`, m?.contextWindow ?? "?", got?.contextWindow ?? JSON.stringify(got)?.slice(0, 60), got?.contextWindow === m?.contextWindow);
}
for (const [model, want] of [["grok-imagine-video", true], ["grok-imagine-video-1.5", false]] as const) {
  const got: any = await safe(() => mc.lookupModelCapabilities(model));
  row("metadata", `${model} videoInput`, want, got?.videoInput ?? JSON.stringify(got)?.slice(0, 60), got?.videoInput === want);
}
const hits: any = await safe(() => mc.searchCatalogModels("kimi", 50));
const v3Kimi = models.filter((m) => m.modelId.toLowerCase().includes("kimi")).length;
row("metadata", "search 'kimi' (picker)", `${v3Kimi} models`, Array.isArray(hits) ? `${hits.length} matches` : hits, Array.isArray(hits) && hits.length > 0);

// ── 6. probe picks (Test All) ────────────────────────────────────────────────
const probeFetch: any = await safe(() => pc.ensureProbeModelsCached());
row("probe", "fetch /probeModels", "200 with both maps", JSON.stringify(probeFetch)?.slice(0, 120), probeFetch?.kind === "ok");
for (const [slug, binding] of [["openai-codex", "openai/codex-subscription"], ["kimi-coding", "moonshotai/kimi-code-subscription"], ["openrouter", "openrouter/gateway"], ["glm-coding", "z-ai/glm-coding-subscription"]] as const) {
  const want = probes.routes[binding]?.externalModelId ?? `(${probes.unavailableRoutes[binding]?.reason})`;
  const got: any = await safe(() => pc.getProbeModel(slug));
  row("probe", `${slug} first model to try`, want, got ?? "null", got === want);
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`live generation ${gen}; sentinel present for this run: ${existsSync(sentinelCopy)}\n`);
let area = "";
for (const r of rows) {
  if (r.area !== area) console.log(`\n[${(area = r.area)}]`);
  console.log(`${r.ok ? "OK  " : "MISS"} ${r.case.padEnd(40)} v3: ${r.v3.slice(0, 60).padEnd(60)} claudish: ${r.claudish.slice(0, 400)}`);
}
console.log(`\n${rows.filter((r) => r.ok).length} OK, ${rows.filter((r) => !r.ok).length} MISS of ${rows.length}`);
export {};
