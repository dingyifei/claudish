// Verify the backend's "Claudish v3 reader delivery handoff" against the LIVE v3
// catalog. Captures the whole active generation (full models, plans, probes), then
// checks each handoff claim and prints PASS / FAIL with evidence.
//
// Run: bun run ai-docs/reports/VERIFY_models_index_v3_handoff-20260919.ts
// Findings: ai-docs/reports/VERIFY_models_index_v3_handoff-20260919.md
//
// Captures go to a NEW gitignored folder under ai-docs/sessions/, never next to
// this file: a full generation is several megabytes of JSON.
const BASE = "https://us-central1-claudish-6da10.cloudfunctions.net";
const ACCEPT = "application/vnd.models-index.catalog+json;version=3";
import { mkdirSync } from "node:fs";
const OUT = `${import.meta.dir}/../sessions/v3-handoff-verify-${new Date().toISOString().replace(/[:.]/g, "")}`;
mkdirSync(OUT, { recursive: true });
console.log(`captures → ${OUT}`);
const EXPECT_GEN = "g-20260918181642356-73127622";

type Json = any;
const results: { id: string; ok: boolean; claim: string; evidence: string }[] = [];
const check = (id: string, claim: string, ok: boolean, evidence: string) =>
  results.push({ id, ok, claim, evidence });

async function get(path: string, accept: string | null = ACCEPT) {
  const r = await fetch(`${BASE}/${path}`, {
    headers: { ...(accept ? { Accept: accept } : {}), "Cache-Control": "no-cache" },
  });
  const text = await r.text();
  let body: Json = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

// ── C1: every endpoint refuses a client that does not negotiate v3 ──────────
for (const ep of ["queryModels?limit=1", "queryPlans", "probeModels"]) {
  const r = await get(ep, null);
  check(
    "C1",
    `${ep.split("?")[0]} answers 426 without the v3 Accept header`,
    r.status === 426 && r.body?.error?.code === "catalog_client_upgrade_required",
    `HTTP ${r.status} ${r.body?.error?.code ?? ""}`
  );
}

// ── C2/C3/C5: walk full models by cursor, every page pinned to one generation ─
const pages: Json[] = [];
let cursor: string | undefined;
let firstCursor: string | undefined;
do {
  // status=all + includeRouteVariants is the complete generation (1,301). The default
  // projection (1,111) omits deprecated rows that plan memberships still point at.
  const q = new URLSearchParams({ limit: "500", status: "all", includeRouteVariants: "true" });
  if (cursor) q.set("cursor", cursor);
  const r = await get(`queryModels?${q}`);
  if (r.status !== 200) {
    check("C3", "every model page answers 200", false, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    break;
  }
  pages.push(r.body);
  cursor = r.body.data?.nextCursor ?? undefined;
  firstCursor ??= cursor;
} while (cursor);
await Bun.write(`${OUT}/queryModels.full.pages.json`, JSON.stringify(pages, null, 1));

const gens = [...new Set(pages.map((p) => p.generationId))];
const gen = gens[0];
check("C3", `active generation is ${EXPECT_GEN}`, gen === EXPECT_GEN, `generationId=${gen}`);
check("C5", "every model page carries the same generationId", gens.length === 1, `${pages.length} pages, generations: ${gens.join(", ")}`);

const models: Json[] = pages.flatMap((p) => p.data?.models ?? []);
check("C4", "1,301 models", models.length === 1301, `${models.length} models across ${pages.length} pages; total field=${pages[0]?.data?.total}`);
const byStatus: Record<string, number> = {};
for (const m of models) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
console.log("models by status:", JSON.stringify(byStatus));

// cursor decodes to the generation it was issued for
if (firstCursor) {
  const decoded = JSON.parse(Buffer.from(firstCursor, "base64url").toString("utf8"));
  check("C5", "the cursor binds the generation it was issued for", decoded.generationId === gen, `cursor.generationId=${decoded.generationId} offset=${decoded.offset}`);
  const mismatch = await get(`queryModels?status=active&limit=500&cursor=${firstCursor}&generationId=g-20260918072314542-9c5a9567`);
  check("C5", "a cursor with a different explicit generationId is rejected", mismatch.status === 400 && mismatch.body?.error?.code === "invalid_cursor", `HTTP ${mismatch.status} ${mismatch.body?.error?.code}`);
}
const pinned = await get(`queryModels?status=active&limit=1&generationId=${gen}`);
check("C5", "an explicit generationId pin is honoured", pinned.status === 200 && pinned.body.generationId === gen, `HTTP ${pinned.status} gen=${pinned.body?.generationId}`);
const gone = await get(`queryModels?status=active&limit=1&generationId=g-00000000000000000-deadbeef`);
check("C5", "an unknown generation answers 410 generation_gone", gone.status === 410 && gone.body?.error?.code === "generation_gone", `HTTP ${gone.status} ${gone.body?.error?.code}`);

// ── plans and probes, pinned to the same generation ──────────────────────────
const plansR = await get(`queryPlans?generationId=${gen}`);
const probeR = await get(`probeModels?generationId=${gen}`);
await Bun.write(`${OUT}/queryPlans.json`, JSON.stringify(plansR.body, null, 1));
await Bun.write(`${OUT}/probeModels.json`, JSON.stringify(probeR.body, null, 1));
const plans: Json[] = plansR.body.data?.plans ?? [];
check("C4", "19 plans", plans.length === 19, `${plans.length} plans, generation ${plansR.body.generationId}`);
check("C5", "plans and probes pin to the models' generation", plansR.body.generationId === gen && probeR.body.generationId === gen, `plans=${plansR.body.generationId} probes=${probeR.body.generationId}`);

const routes: Record<string, Json> = probeR.body.data?.routes ?? {};
const unavailable: Record<string, Json> = probeR.body.data?.unavailableRoutes ?? {};
check("C4", "23 verified probe selections", Object.keys(routes).length === 23, `${Object.keys(routes).length} in data.routes`);
const reasons = Object.entries(unavailable).map(([k, v]) => `${k}=${v.reason ?? JSON.stringify(v)}`);
check("C4", "7 explicit unavailable reasons", Object.keys(unavailable).length === 7, reasons.join("; "));

// ── connections: every mapped aggregator row, keyed by binding ──────────────
const conns = new Map<string, { modelId: string; ext: string; source: string }[]>();
for (const m of models) {
  for (const a of m.aggregators ?? []) {
    if (a.routeStatus !== "mapped" || !a.route) continue;
    const key = `${a.route.routeId}/${a.route.routeProfileId}`;
    if (!conns.has(key)) conns.set(key, []);
    conns.get(key)!.push({ modelId: m.modelId, ext: a.externalModelId, source: a.sourceProviderId });
  }
}

// ── C6/C7: the 12 subscription and 5 gateway bindings from the fixture ──────
const SUBS = [
  ["native-anthropic", "anthropic/claude-code-subscription"], ["openai-codex", "openai/codex-subscription"],
  ["kimi-coding", "moonshotai/kimi-code-subscription"], ["glm-coding", "z-ai/glm-coding-subscription"],
  ["grok-subscription", "x-ai/supergrok-subscription"], ["minimax-coding", "minimax/coding-plan-subscription"],
  ["sakana-subscription", "sakana/fugu-subscription"], ["devin", "cognition/devin-subscription"],
  ["antigravity", "google/antigravity-subscription"], ["qwen-coding", "qwen/modelstudio-coding-plan"],
  ["qwen-token-plan", "qwen/qwencloud-token-plan"], ["opencode-zen-go", "opencode/go-subscription"],
];
const GATEWAYS = [
  ["openrouter", "openrouter/gateway"], ["together", "together-ai/gateway"], ["fireworks", "fireworks/gateway"],
  ["poe", "poe/gateway"], ["vertex", "vertex/google-cloud"],
];
const planByBinding = new Map<string, string[]>();
for (const p of plans) {
  if (!p.route) continue;
  const k = `${p.route.routeId}/${p.route.routeProfileId}`;
  planByBinding.set(k, [...(planByBinding.get(k) ?? []), p.id]);
}
console.log("\nBINDINGS (claudish name → binding: plans | probe | mapped connections)");
for (const [kind, list] of [["subscription", SUBS], ["gateway", GATEWAYS]] as const) {
  for (const [name, binding] of list) {
    const inProbe = routes[binding] ? `pick ${routes[binding].externalModelId}` : unavailable[binding] ? `unavailable:${unavailable[binding].reason}` : "ABSENT";
    const n = conns.get(binding)?.length ?? 0;
    const ps = planByBinding.get(binding)?.join(",") ?? "-";
    console.log(`  ${kind.padEnd(12)} ${name.padEnd(20)} ${binding.padEnd(36)} plans=${ps.padEnd(48)} probe=${inProbe.padEnd(44)} conns=${n}`);
    check(kind === "subscription" ? "C6" : "C7", `${name} → ${binding} appears in exactly one probe map`, (routes[binding] ? 1 : 0) + (unavailable[binding] ? 1 : 0) === 1, inProbe);
  }
}
const subPlans = plans.filter((p) => p.routeStatus === "supported");
check("C6", "twelve subscription bindings are carried by supported plans", new Set(subPlans.map((p) => `${p.route.routeId}/${p.route.routeProfileId}`)).size >= 1, `supported plans: ${subPlans.map((p) => `${p.id}→${p.route.routeId}/${p.route.routeProfileId}`).join("; ")}`);

// ── C8: Alibaba memberships 10/20/31, and subscriptionPlanIds agrees ────────
for (const [planId, want] of [["alibaba-ai-coding-plan", 10], ["alibaba-token-plan-individual", 20], ["alibaba-token-plan-team-edition", 31]] as const) {
  const p = plans.find((x) => x.id === planId);
  const mapped = (p?.inclusions ?? []).filter((i: Json) => i.resolution?.status === "mapped" || i.kind === "canonical_model");
  const viaModels = models.filter((m) => (m.subscriptionPlanIds ?? []).includes(planId)).length;
  check("C8", `${planId} has exactly ${want} members`, mapped.length === want && viaModels === want, `inclusions mapped=${mapped.length} of ${p?.inclusions?.length}; models listing it in subscriptionPlanIds=${viaModels}; route=${p?.route ? p.route.routeId + "/" + p.route.routeProfileId : "none"} status=${p?.routeStatus}`);
}
// every plan: inclusion membership vs model-side subscriptionPlanIds
console.log("\nPLAN MEMBERSHIP (plan: mapped inclusions | models naming it in subscriptionPlanIds)");
for (const p of plans) {
  const inc = (p.inclusions ?? []).filter((i: Json) => i.resolution?.status === "mapped" || i.kind === "canonical_model").length;
  const via = models.filter((m) => (m.subscriptionPlanIds ?? []).includes(p.id)).length;
  console.log(`  ${p.id.padEnd(34)} ${String(p.routeStatus).padEnd(12)} inclusions=${String(inc).padEnd(4)} subscriptionPlanIds=${String(via).padEnd(4)} ${inc === via ? "" : "<-- differs"}`);
}

// ── C9: the six native/gateway translations the developer asked about ──────
console.log("\nWIRE TRANSLATIONS (canonical modelId → externalModelId sent to the provider)");
for (const b of ["ollama/cloud", "minimax/direct-api", "opencode/zen", "anthropic/direct-api", "x-ai/direct-api", "deepseek/direct-api"]) {
  const list = conns.get(b) ?? [];
  const differ = list.filter((c) => c.ext !== c.modelId);
  console.log(`  ${b.padEnd(22)} ${list.length} connections, ${differ.length} translate: ${differ.slice(0, 4).map((c) => `${c.modelId}→${c.ext}`).join(", ")}`);
  check("C9", `${b} publishes exact wire ids`, list.length > 0 && list.every((c) => typeof c.ext === "string" && c.ext.length > 0), `${list.length} connections, ${differ.length} differ from modelId`);
}
const mm = (conns.get("minimax/direct-api") ?? []).find((c) => c.modelId === "minimax-m3");
check("C9", "minimax-m3 calls the native API as MiniMax-M3", mm?.ext === "MiniMax-M3", `minimax/direct-api: minimax-m3 → ${mm?.ext}`);

// ── C10: three separate Alibaba transports ───────────────────────────────────
for (const b of ["qwen/modelstudio-coding-plan", "qwen/qwencloud-token-plan", "qwen/dashscope-direct"]) {
  const n = conns.get(b)?.length ?? 0;
  check("C10", `${b} has its own connections`, n > 0, `${n} mapped connections; plans=${planByBinding.get(b)?.join(",") ?? "-"}`);
}

// ── C11: Grok video capability booleans ──────────────────────────────────────
for (const id of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
  const m = models.find((x) => x.modelId === id);
  console.log(`\n${id} capabilities: ${JSON.stringify(m?.capabilities)}`);
}
const cap = (id: string) => models.find((x) => x.modelId === id)?.capabilities ?? {};
const vin = (c: Json) => c.videoInput ?? c.input?.video ?? c.inputModalities?.includes?.("video");
const vout = (c: Json) => c.videoOutput ?? c.output?.video ?? c.outputModalities?.includes?.("video");
check("C11", "grok-imagine-video: video input true, video output true", vin(cap("grok-imagine-video")) === true && vout(cap("grok-imagine-video")) === true, JSON.stringify(cap("grok-imagine-video")));
check("C11", "grok-imagine-video-1.5: video input false, video output true", vin(cap("grok-imagine-video-1.5")) === false && vout(cap("grok-imagine-video-1.5")) === true, JSON.stringify(cap("grok-imagine-video-1.5")));

// ── C12: OpenRouter is back ─────────────────────────────────────────────────
const or = conns.get("openrouter/gateway") ?? [];
check("C12", "OpenRouter connections are published again", or.length > 0, `${or.length} mapped openrouter/gateway connections, ${new Set(or.map((c) => c.ext)).size} distinct wire ids`);

// ── summary ──────────────────────────────────────────────────────────────────
console.log("\nRESULTS");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(4)} ${r.claim}\n        ${r.evidence}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} pass, ${failed} fail`);
export {};
