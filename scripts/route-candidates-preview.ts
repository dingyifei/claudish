#!/usr/bin/env bun
/**
 * What the routing redesign WOULD do, without doing it.
 *
 * Phase 2A builds candidate gathering as a pure module that nothing calls. This
 * script calls it for every model in the cloud models catalog and compares the
 * result against the chain `route()` produces today, so the redesign can be
 * judged before it is wired in rather than after.
 *
 * It answers the only question that blocks the wiring: which models would LOSE a
 * provider they can reach today. A gain is a decision to review; a loss is a user
 * whose key stops working, with no error to read.
 *
 *   bun run scripts/route-candidates-preview.ts [--limit=N] [--show=modelId]
 *
 * Read-only: it resolves routes and gathers candidates, and writes nothing.
 */

import { readAllModelsCache } from "../packages/cli/src/providers/all-models-cache.js";
import { ensureEndpointsRegistered } from "../packages/cli/src/providers/endpoint-registration.js";
import { gatherRouteCandidates } from "../packages/cli/src/providers/route-candidates.js";
import { route } from "../packages/cli/src/providers/routing-rules.js";

// MANDATORY before gathering. Bundled and user endpoints (together, fireworks,
// and every predefined row) only acquire a provider definition once this runs, and
// a provider with no definition has no tier, so it is dropped as unmappable. Left
// out, this script reports 241 together-ai connections as unroutable and blames the
// redesign for a loss it did not cause.
await ensureEndpointsRegistered();

const cache = readAllModelsCache();
if (!cache || cache.entries.length === 0) {
  console.error("No cloud models catalog cache. Refresh it first.");
  process.exit(1);
}

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const showArg = process.argv.find((arg) => arg.startsWith("--show="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
const show = showArg?.split("=")[1];

const entries = limit ? cache.entries.slice(0, limit) : cache.entries;

/** Providers the candidate list offers but today's chain does not, and the reverse. */
const gainedBy = new Map<string, number>();
const lostBy = new Map<string, number>();
const lostExamples: string[] = [];
let identical = 0;
let reordered = 0;
let candidateEmpty = 0;
const unmappedRoutes = new Map<string, number>();

for (const entry of entries) {
  const plan = await route(entry.modelId);
  const todayProviders =
    plan.kind === "ok" ? [plan.primary, ...plan.fallbacks].map((hop) => hop.provider) : [];

  const gathering = gatherRouteCandidates(entry.modelId);
  for (const unmapped of gathering.unmappedRoutes) {
    unmappedRoutes.set(unmapped, (unmappedRoutes.get(unmapped) ?? 0) + 1);
  }
  const tomorrowProviders = gathering.candidates.map((candidate) => candidate.provider);

  if (tomorrowProviders.length === 0) candidateEmpty++;

  const todaySet = new Set(todayProviders);
  const tomorrowSet = new Set(tomorrowProviders);
  const lost = todayProviders.filter((provider) => !tomorrowSet.has(provider));
  const gained = tomorrowProviders.filter((provider) => !todaySet.has(provider));

  for (const provider of lost) lostBy.set(provider, (lostBy.get(provider) ?? 0) + 1);
  for (const provider of gained) gainedBy.set(provider, (gainedBy.get(provider) ?? 0) + 1);

  if (lost.length > 0 && lostExamples.length < 25) {
    lostExamples.push(
      `${entry.modelId}: today ${todayProviders.join(" -> ")}\n      candidates ${tomorrowProviders.join(" -> ")}`,
    );
  }
  if (lost.length === 0 && gained.length === 0) {
    if (todayProviders.join("|") === tomorrowProviders.join("|")) identical++;
    else reordered++;
  }

  if (show && entry.modelId === show) {
    console.log(`\n=== ${entry.modelId} (vendor ${entry.provider ?? "unknown"}) ===`);
    console.log(`today:      ${todayProviders.join(" -> ") || "(no route)"}`);
    console.log("candidates:");
    for (const candidate of gathering.candidates) {
      console.log(
        `  ${candidate.tier.padEnd(21)} ${candidate.provider.padEnd(18)} ${candidate.wireId.padEnd(34)} ` +
          `${candidate.isVendorOwn ? "vendor" : "      "} ${candidate.price.label.padEnd(22)} ` +
          `ctx ${candidate.contextWindow ?? "-"}  ${candidate.source}`,
      );
    }
  }
}

console.log(`\nCompared ${entries.length} models on generation ${cache.catalogGenerationId}.`);
console.log(`  identical provider sets, same order: ${identical}`);
console.log(`  identical set, different order:      ${reordered}`);
console.log(`  no candidates gathered at all:       ${candidateEmpty}`);

const table = (title: string, counts: Map<string, number>): void => {
  console.log(`\n## ${title}`);
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) console.log("  none");
  for (const [provider, count] of rows) console.log(`  ${provider.padEnd(22)} ${count} models`);
};

table("Providers GAINED (reachable by bare name that are not today)", gainedBy);
table("Providers LOST (reachable today, absent from candidates) — must be justified", lostBy);

if (lostExamples.length > 0) {
  console.log(`\n## Loss examples (first ${lostExamples.length})`);
  for (const example of lostExamples) console.log(`    ${example}`);
}

if (unmappedRoutes.size > 0) {
  console.log("\n## Catalog routes that resolve to no claudish provider");
  for (const [route_, count] of [...unmappedRoutes].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${route_.padEnd(38)} ${count} connections`);
  }
}
