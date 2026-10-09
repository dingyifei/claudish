// Verify the promises in models-index ai-docs/alibaba-provider-changes.md (the shared
// Alibaba / v3 contract) that the handoff verification did not cover, against the
// LIVE generation. Findings: ai-docs/reports/VERIFY_models_index_v3_handoff-20260919.md
//
// Run: bun run ai-docs/reports/VERIFY_models_index_v3_contract-20260919.ts
const BASE = "https://us-central1-claudish-6da10.cloudfunctions.net";
const ACCEPT = "application/vnd.models-index.catalog+json;version=3";
type Json = any;
const results: { id: string; ok: boolean | "info"; claim: string; evidence: string }[] = [];
const check = (id: string, claim: string, ok: boolean | "info", evidence: string) =>
  results.push({ id, ok, claim, evidence });
async function get(path: string): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${BASE}/${path}`, { headers: { Accept: ACCEPT, "Cache-Control": "no-cache" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// complete projection, pinned by cursor
const models: Json[] = [];
let cursor: string | undefined;
let gen: string | undefined;
do {
  const q = new URLSearchParams({ limit: "200", status: "all", includeRouteVariants: "true" });
  if (cursor) q.set("cursor", cursor);
  const r = await get(`queryModels?${q}`);
  gen ??= r.body.generationId;
  models.push(...(r.body.data?.models ?? []));
  cursor = r.body.data?.nextCursor ?? undefined;
} while (cursor);
const plans: Json[] = (await get(`queryPlans?generationId=${gen}`)).body.data.plans;
const planById = new Map(plans.map((p) => [p.id, p]));
console.log(`generation ${gen}: ${models.length} models, ${plans.length} plans`);

// ── K1 (contract responsibility 3, AMENDED 2026-09-19 by models-index 704d456) ──
// Was: "unknown, without a callable plan route". Now: supported through
// qwen/modelstudio-coding-plan, with probes, defaults and recommendations using its
// exact published membership and the dedicated qcode credential boundary.
const coding = planById.get("alibaba-ai-coding-plan");
check("K1", "Coding Plan: routeStatus supported, route qwen/modelstudio-coding-plan",
  coding?.routeStatus === "supported" && coding?.route?.routeId === "qwen" && coding?.route?.routeProfileId === "modelstudio-coding-plan",
  `routeStatus=${coding?.routeStatus} route=${JSON.stringify(coding?.route)} routeReason=${coding?.routeReason}`);

// ── K2: its probe pick is one of its own published members, on its own binding ──
const probe = (await get(`probeModels?generationId=${gen}`)).body.data;
const pick = probe.routes["qwen/modelstudio-coding-plan"];
const codingMembers = new Set((coding?.inclusions ?? []).map((i: Json) => i.externalModelId));
check("K2", "Coding Plan probe pick is one of its exact published members",
  !!pick && codingMembers.has(pick.externalModelId) && pick.planId === "alibaba-ai-coding-plan",
  `pick=${JSON.stringify(pick)}; members=${[...codingMembers].join(",")}`);
const tokenLeak = JSON.stringify(pick ?? {}).includes("qwencloud-token-plan");
check("K2", "Coding Plan never references the Token Plan binding", !tokenLeak && coding?.route?.routeProfileId !== "qwencloud-token-plan", `pick mentions token plan: ${tokenLeak}`);

// ── K3: unknown aggregator rows carry no callable id ──
let unknown = 0, unknownWithCallable = 0, unknownWithObserved = 0, mappedWithoutExt = 0;
const reasons: Record<string, number> = {};
for (const m of models) for (const a of m.aggregators ?? []) {
  if (a.routeStatus === "unknown") {
    unknown++;
    if (a.externalModelId !== undefined || a.route) unknownWithCallable++;
    if (a.observedExternalModelId) unknownWithObserved++;
    reasons[a.routeReason ?? a.reason ?? "?"] = (reasons[a.routeReason ?? a.reason ?? "?"] ?? 0) + 1;
  } else if (a.routeStatus === "mapped" && !a.externalModelId) mappedWithoutExt++;
}
check("K3", "unknown rows have no externalModelId and no route", unknownWithCallable === 0, `${unknown} unknown rows, ${unknownWithCallable} with a callable id, ${unknownWithObserved} with observedExternalModelId; reasons ${JSON.stringify(reasons)}`);
check("K3", "every mapped row has an externalModelId", mappedWithoutExt === 0, `${mappedWithoutExt} mapped rows without one`);

// ── K4: PAYG is metered, not a subscription record ──
const paygPlans = plans.filter((p) => p.route?.routeProfileId === "dashscope-direct");
check("K4", "no plan is bound to qwen/dashscope-direct", paygPlans.length === 0, `${paygPlans.length} plans`);

// ── K5: Individual and Team are separate Token Plan records; Credit Pack validity sourced ──
const ind = planById.get("alibaba-token-plan-individual");
const team = planById.get("alibaba-token-plan-team-edition");
check("K5", "Token Plan Individual and Team are separate records on one binding",
  !!ind && !!team && ind.route?.routeProfileId === "qwencloud-token-plan" && team.route?.routeProfileId === "qwencloud-token-plan",
  `individual=${ind?.displayName} team=${team?.displayName}`);
const packs = plans.flatMap((p) => (p.pricing ?? []).filter((x: Json) => /pack/i.test(JSON.stringify(x))).map((x: Json) => ({ plan: p.id, ...x })));
check("info", "Credit Pack pricing records", "info", JSON.stringify(packs));

// ── K6: video capability fields, no duplicate field ──
const capKeys = new Set<string>();
for (const m of models) for (const k of Object.keys(m.capabilities ?? {})) capKeys.add(k);
const videoKeys = [...capKeys].filter((k) => /video/i.test(k));
check("K6", "exactly videoInput and videoOutput carry video capability", videoKeys.sort().join(",") === "videoInput,videoOutput", `video keys: ${videoKeys.join(", ")}; all keys: ${[...capKeys].sort().join(", ")}`);

// ── K7: redirects ──
const red = await get(`queryModels?catalog=redirects&generationId=${gen}`);
const redirects = red.body?.data?.redirects ?? red.body?.data?.models ?? [];
check("K7", "3 provider model redirects published", redirects.length === 3, `HTTP ${red.status}; ${redirects.length}: ${JSON.stringify(redirects).slice(0, 400)}`);

// ── K8: roster coverage on the current generation ──
const cov = plans.map((p) => `${p.id}=${p.rosterCoverage?.status ?? "none"}${p.rosterCoverage?.expiresAt ? "@" + p.rosterCoverage.expiresAt.slice(0, 10) : ""}`);
check("K8", "every plan carries rosterCoverage", plans.every((p) => p.rosterCoverage?.status), cov.join("; "));

// ── K9: product labels (contract responsibility 6) ──
const labels = ["alibaba-ai-coding-plan", "alibaba-token-plan-individual", "alibaba-token-plan-team-edition"].map((id) => `${id} → "${planById.get(id)?.displayName}"`);
check("info", "Alibaba plan display names (contract names the products Alibaba Coding Plan / Token Plan / PAYG)", "info", labels.join("; "));

console.log("\nRESULTS");
for (const r of results) console.log(`${r.ok === "info" ? "INFO" : r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(4)} ${r.claim}\n        ${r.evidence}`);
const failed = results.filter((r) => r.ok === false).length;
console.log(`\n${results.filter((r) => r.ok === true).length} pass, ${failed} fail`);
export {};
