# Follow-up review — models-index v3 remediation, commit `d7acfd7`

**Reviewer:** claudish client team
**Target:** `d7acfd7` ("fix(catalog): remediate v3 review findings"), PR #151, baseline `a0658df`
**Prior review:** `ai-docs/reports/REVIEW_models_index_v3_impl-20260913.md`
**Spec:** `~/.claude/plans/gleaming-discovering-marble.md` (the remediation plan; its sections 1-6 map 1:1 to the six findings)
**Date:** 2026-09-13
**Mode:** read-only. Nothing in that repo was modified, staged, executed, or tested.

## Method note — the working tree is NOT the commit

That worktree is mid-merge with `origin/main`: its status shows `UU`/`DU`/`AA` conflict
states, and `functions/src/collectors/api/mistral.ts` on disk literally contains a
`<<<<<<< HEAD` marker. `merger.ts`, `index.ts`, and `schema-runtime.ts` on disk differ from
`d7acfd7`. **Everything below was read out of the commit object itself**, except files I
first proved byte-identical to the commit (`catalog-v3-builder.ts`,
`catalog-v3-deliberate-diff.ts`, `mistral-identity-policy.ts`,
`subscription-plan-reconciliation.ts`, `subscription-alias-validation.ts`, the cutover
workflow, and every test file except `merger-aliases.test.ts`). Anyone re-checking this
report must do the same; the on-disk tree will mislead you.

## Verdict

**FAIL** — 1 CRITICAL, 1 HIGH, 2 MEDIUM, 2 LOW.

Five of the six original findings are genuinely fixed, several of them well: HIGH-1,
MEDIUM-1, MEDIUM-2 (for the reproduced case), and MEDIUM-3 are clean, and the Mistral
quarantine's seven reviewed rows are now reachable and asserted end-to-end through the
real merge path — including the pre-remapped case, which now has a test.

But the remediation introduces **two new defects that are worse than what they replaced**,
and both are the same pattern the review was told to hunt: a correct rule whose execution
path meets inputs the reviewed table does not describe.

- **CRITICAL-1** — Mistral's live `/v1/models` contains `-latest` pointers beyond the
  reviewed seven. Each one now becomes a canonical model id, which `buildCatalogCandidateV3`
  rejects by throwing — before staging, before activation. That is a total,
  every-run catalog-generation outage, not a frozen catalog.
- **HIGH-1(new)** — the dangling-supplemental cleanup is keyed on the pre-retention merged
  model set, so it silently strips a **legitimate** Codex plan inclusion from a model the
  same generation still publishes. That is the "costs a flat-rate user money" outcome the
  cleanup was supposed to avoid, converted from a loud throw into a silent under-report.

Nothing here touches the wire contract. Our 426 guard remains correct and is now pinned to
a committed fixture on their side too.

## Item-by-item

| # | Original finding | Their claim | Result |
|---|---|---|---|
| 1 | HIGH-1 deliberate-diff gate | freshness-only projection | **VERIFIED** |
| 2 | HIGH-2 Mistral quarantine | shared identity prep + fail-closed guards | **PARTIAL** — seven rows fixed; introduces CRITICAL-1 and MEDIUM-1 |
| 3 | MEDIUM-1 unscoped alias index | retired v2 graph removed | **VERIFIED** (gone, not merely unused) |
| 4 | MEDIUM-2 dangling inclusion | supplemental cleanup w/ prior provenance | **PARTIAL** — reproduced case fixed; introduces HIGH-1(new) |
| 5 | MEDIUM-3 Accept verification | no-Accept 426 asserted in `verify-public` | **VERIFIED** |
| 6 | LOW-1 error vocabulary | deferred to a contract amendment | **PARTIAL** — correctly un-applied, but not recorded in the repo |

### 1. HIGH-1, the deliberate-diff gate — VERIFIED (a)(b)

`catalog-v3-deliberate-diff.ts:125-159` projects away exactly the four freshness surfaces
the plan names and nothing else: `deliberatePlan` drops `lastUpdated`; `deliberateRoster`
drops roster `observedAt`/`expiresAt`/`contentHash` **and** per-entry
`observedAt`/`expiresAt`; `deliberateRedirect` drops `observedAt`.

I checked the inverse risk you flagged, because dropping `contentHash` is the dangerous
part — a hash is a proxy for content, and removing it could remove the only witness to a
content change. It does not: the projection retains every field of
`AuthoritativeRosterV3Schema` that carries meaning (`schema-runtime.ts:1031-1050`) —
`entries[]` with `sourceText`/`externalModelId`/`modelId`, plus `snapshotEntryCount`,
`planIds`, `authority`, `scope`, `sourceKind`, `sourceUrl`, `refreshOwner`. A model added
to or removed from a roster changes `entries` **and** `snapshotEntryCount`, so it still
trips the gate. `contentHash` was removable precisely because it is derived from data that
stays in the projection.

**Content-change-coinciding-with-timestamp-change is safe by construction, not by luck.**
`addChangedSurface` compares canonical JSON of the *projected* value, and the projection is
per-field: the timestamps are gone from both sides before comparison, so a simultaneous
content edit is the only thing left to differ. Their test at `:84-101` proves the
content-only half (`entries[0].sourceText`, and a redirect `toModelId` remap), and `:206-287`
table-drives 13 semantic mutations including `rosters[0].sourceUrl` and plan `features`,
each asserting `changed === true` **and** a digest different from the unchanged digest.

I also confirmed no *other* volatile field survives in the compared surfaces:
`PlanBaseV3SchemaShape` (`:789-800`) has exactly one timestamp (`lastUpdated`, stripped);
`ModelInclusionV3Schema` (`:736-773`) and `RosterRequirementV3Schema` (`:782-787`) have none;
`CatalogModelV3Schema` (`:1147-1174`) has no `lastUpdated`, no popularity, and no
observation timestamp at all. So the `plans` and `rosters` surfaces are now genuinely
stable across a no-op collection.

Path reached, with the inputs that occur in practice: `catalog-v3-publication.test.ts:20-46`
publishes G0 then G1 from the same collection input at a later `generatedAt` and asserts
`g1.publication.activated === true` with `control.revision === 2`. That is the exact
scenario I predicted would freeze forever, now asserted green end-to-end through
`publishCatalogV3`. The former "must re-submit with `approvedDiffDigest`" test was rewritten
to use a real semantic mutation (`mergedModels[0].displayName`), as the plan required.

Their decision to skip staging-path retention is sound given this fix: the 8-pending-per-day
accumulation mode was a consequence of the freeze, not an independent defect.

### 2. HIGH-2, the Mistral quarantine — PARTIAL

**What is genuinely fixed (a)(b).** The keying defect is gone.
`prepareCollectorResultsForCatalogV3` (`merger.ts` at `d7acfd7`, the block replacing the old
`mergeResults` body) runs `recanonicalizeAliasBackedRawModels` **once** over a deep clone of
every collector row and re-slices the result back per collector; `mergePreparedResults` and
`collectServingEvidence` then consume the *same* rows. `index.ts:427-486` wires the real
pipeline to it — `mergePreparedResults(catalogCollectorResults)` for models and
`collectorResults: catalogCollectorResults` for the builder — so the pre-merge/post-merge
split that made the quarantine unreachable no longer exists. The re-slice is order- and
length-safe today: both stages inside `recanonicalizeAliasBackedRawModels` are `.map()`.

**All seven rows are now reachable AND published, not merely decided (b).**
`catalog-v3-builder.test.ts:97-135` is a real collector-to-builder integration test: it feeds
seven `mistral-api` rows whose `canonicalId === externalId ===` the pointer, plus
`mistral-model-pages-scrape` rows for the seven dated targets, runs
`prepareCollectorResultsForCatalogV3` then `mergePreparedResults` then
`buildCatalogCandidateV3`, then loops `Object.entries(MISTRAL_POINTER_QUARANTINE_V3)`
asserting for each that no model is published under the pointer id **and** that the dated
model's `aggregators` contains `{sourceProviderId:"mistralai",
sourceCollectorId:"mistral-api", routeStatus:"unknown", reason: <policy.reason>,
observedExternalModelId: <pointer>}`. That covers `mistral-medium-2604` and
`mistral-small-2603` as `identity_conflict` and the other five as `mutable_pointer_only`,
exactly as section 4.2 requires. The `unknown` variant still carries no `route` and no
`externalModelId` — enforced structurally by the `.strict()` `unknown` branch of
`AggregatorRouteV3Schema` (`schema-runtime.ts:1002-1013`), unchanged.

**The pre-remapped path is now covered by a test, not only reasoned about (b).**
`merger-aliases.test.ts` (new test "does not let gateway alias evidence stabilize a Mistral
API pointer") is precisely your case: a `mistral-api` row with `externalId:
"mistral-large-latest"` whose `canonicalId` is **already** `mistral-large-2512`, plus an
OpenRouter row carrying the alias. It asserts the prepared row's `canonicalId` is reset to
`"mistral-large-latest"` — i.e. ingress's remap is undone because no *owner* source
independently observed the dated id (`isOwnerTopLevelSource`, `merger.ts:951-958`; OpenRouter
is not an owner for `mistralai`). Combined with `catalog-v3-builder.test.ts:178-199`
("blocks unresolved mutable Mistral canonical identities"), the chain is established. This
closes the gap their session told us about.

**A dated canonical still cannot carry a pointer as its mapped `externalModelId` (a).**
`projectServingEvidence` (`subscription-alias-validation.ts:149-165`) keeps all four layered
guards, and the catch-all still demands `externalModelId === canonicalModelId &&
officialCallableEvidence === true` for every dated Mistral id. `officialCallableEvidence` is
still set in exactly one place and only for `mistral-api` rows where
`externalId === canonicalId` (`catalog-v3-builder.ts:396-400`) — note this now reads the
*prepared* canonicalId, so a remapped pointer row can never claim it. The dated-token regex
gap I reported is also closed: `isDatedMistralModelIdV3` now anchors with `(?=-|$)`
(`mistral-identity-policy.ts:52-54`) and is tested against
`mistral-ocr-2505-completion` (`subscription-alias-validation.test.ts:114-131`).

**The orphan guard requested by plan section 2 item 6 exists**
(`catalog-v3-builder.ts:124-135`): any `routesByModelId` key absent from `mergedModelIds` is
a violation, tested at `catalog-v3-builder.test.ts:201-217`. Evidence is no longer silently
discarded.

**What is not fixed, and what the fix broke: see CRITICAL-1 and MEDIUM-1 below.**

### 3. MEDIUM-1, the unscoped alias index — VERIFIED, it is gone (a)

Not merely unreferenced — deleted. The commit's recursive tree listing has no
`subscription-plan-membership.ts`, `writer.ts`, `recommender.ts`,
`recommended-route-contract.ts`, `algolia-catalog.ts`, `search-bag-builder.ts`,
`plugin-defaults.ts`, `seed-plugin-defaults.ts`, `recommended-subscription-coverage.ts`,
`recommended-subscription-projection.test.ts`, or
`scripts/check-recommended-subscription-coverage.ts`, plus all their tests
(-9,291 lines in the commit; `writer.ts` and `writer.test.ts` are in the tail of the stat).
The only files left matching those names are the v3 ones, `catalog-v3-recommender.ts` and
`plugin-defaults-handler.ts`.

`attachSubscriptionPlanMembership` and `canonicalizeSubscriptionPlanId` return zero hits
repo-wide. The retired Zod graph (`RecommendedModelsDocSchema`, `RecommendedModelEntrySchema`,
`RecommendedSubscriptionSchema`, `validateRecommendedDoc`) is stripped from
`schema-runtime.ts`; `schema.ts` loses 110 lines. `providerUid` and `includedModels` now
survive **only** as forbidden-field names in the runtime scan list
(`schema-runtime.ts:1334-1335`), as negative test assertions, and as an unrelated local
variable in the MiniMax collector (`collectors/scraper/minimax.ts:487`). `algoliasearch` is
out of `functions/package.json`; the dead CI steps and the `catalog-invariants.yml` workflow
that ran the retired check are removed. `ACCESS_METHODS` no longer exists anywhere — the
plan's "extract then migrate" became "delete the only consumer", which is a better outcome.

There is no path by which a future caller reintroduces the unscoped join without writing it
from scratch.

### 4. MEDIUM-2, the generation-blocking dangling inclusion — PARTIAL (a)(b)

The no-applicable-roster case I reproduced **is** fixed, and fixed at the right spot. In
`applyRosterEvidenceToPlansV3` the `retained` filter is now computed **before** the
`applicable.length === 0` early return, and that return re-emits the plan with the pruned
inclusions (`subscription-plan-reconciliation.ts`, the
`if (applicable.length === 0) return retained.length === plan.inclusions.length ? plan : {...plan, inclusions: retained}`
block). The stale positive is matched by a `provider` + `externalModelId` key against
`supplementalEntryKeys`, which unions current applicable rosters with
`supplementalProvenanceRosters` — passed by the builder as `input.activeV3?.rosters`
(`catalog-v3-builder.ts:96-101`), so an **expired** prior roster still serves as provenance
for removing its own positives while being barred from adding any.

Tested for the case I reproduced, not only the easy one:
`subscription-plan-reconciliation.test.ts` adds "uses an expired supplemental roster only to
remove its carried positives" (empty `rosters`, provenance-only, asserts the unrelated
inclusion survives and the dangling one goes) and "drops dangling supplemental positives
without granting membership"; `catalog-v3-builder.test.ts:344-414` and `:416-490` drive both
through two real generations. Authority is preserved: the entry-level skip is guarded on
`roster.authority === "supplemental"`, and "keeps a dangling authoritative inclusion fatal"
asserts the throw still fires.

**The cleanup can nonetheless remove a legitimate inclusion — see HIGH-1(new).**

### 5. MEDIUM-3, Accept verification — VERIFIED, and it covers the case that matters (a)

`.github/workflows/catalog-v3-cutover.yml` `verify-public` now issues the no-Accept request
through `node:https.request` with only a `cache-control` header — deliberately avoiding
`fetch`, which injects `accept: */*` and would have tested the wrong thing. `*/*` is itself a
426 in their implementation, so the bug would have hidden. `assertUpgradeRequired` asserts
HTTP 426, top-level `contractVersion === 3`, `error.code ===
"catalog_client_upgrade_required"`, `error.minimumContractVersion === 3`, and
`Object.hasOwn(body,"data") === false`, and throws otherwise (failing the step and the
cutover). The `accept: application/json` case is asserted the same way. **This is the exact
request claudish sends, now verified against production rather than attested.**

They also committed `docs/fixtures/catalog-v3-upgrade-required.json` and replaced the inline
literal in `catalog-v3-http.test.ts:94` with a `toEqual` against that file, so their contract
test and our parser test can pin the same artifact. We asked for this; we got it.

### 6. LOW-1, the deferral — PARTIAL (a)

**Nothing half-applies it, confirmed.** `CatalogErrorCodeV3` (`schema.ts:390-394`) is
unchanged at four codes; no method-specific code was invented; the 405 still carries
`catalog_unavailable` and still only on the admin endpoint
(`catalog-v3-manual-handler.ts:73`); `invalid_cursor` is unchanged and still documented.
No cursor or method failure was reclassified as an availability failure.

**But the deferral is not recorded anywhere durable in the repo.** Searches for `405`,
`method_not_allowed`, `deferr`, and `amendment` across `docs/` and the v3 HTTP/schema
sources at `d7acfd7` return nothing; `docs/api-reference.md` gained only the fixture link,
and `CLAUDE.md`'s four changed lines are about the test command. The plan itself (section 6)
only ever asked for it to be recorded "in the PR update" — i.e. a PR comment, which
disappears from the repo's own history the moment PR #151 merges. Ask for two lines in
`docs/api-reference.md` next to the error table.

---

## Findings, most severe first

Regressions introduced by the remediation come first, per your ranking rule.

### CRITICAL-1 — Every Mistral `-latest` id outside the reviewed seven now becomes a canonical model and hard-blocks the whole catalog generation, on every run (a, with the live-roster premise at (b))

**Locations:** `merger.ts` at `d7acfd7` — `applyReviewedMistralPointerTargets` and the
`unresolvedMistralPointer` short-circuit inside `recanonicalizeAliasBackedRawModels`;
`catalog-v3-builder.ts:105-116`; `collectors/api/mistral.ts` at `d7acfd7`, `collect()`;
`schema-runtime.ts:420-456` `canonicalizeMistralModelId`.

**The mechanism, step by step — every step read in the committed source.**

1. `MistralCollector.collect()` emits one `RawModel` for **every** id in
   `https://api.mistral.ai/v1/models`, `-latest` pointers included, with
   `canonicalId: selectCanonicalMistralId(m)` — which is the API id verbatim
   (`selectCanonicalMistralId` is a one-line `normalizeMistralId(model.id) ?? model.id`).
   The only rows skipped are embed/moderation ids that also carry a non-chat `type`.
2. `applyReviewedMistralPointerTargets` intercepts every `mistral-api` row whose
   `externalId` is a pointer and looks it up in the **seven-entry** inverse map
   `MISTRAL_CANONICAL_ID_BY_POINTER_V3` (`mistral-identity-policy.ts:35-50`). A hit whose
   dated target is independently observed gets the reviewed dated `canonicalId`. **A miss
   falls through to `canonicalId: canonicalizeModelId(raw.externalId)`, which for an
   unreviewed pointer is the pointer itself**, with the comment "Keep it visibly mutable so
   the v3 candidate gate can reject it".
3. `unresolvedMistralPointer` then disables **both** alias-remap paths for that row
   (`externalMappedCanonical` and `mayUseCurrentCanonicalAlias`), so the owner-page and
   pricing evidence that used to fold the pointer onto its dated model is now refused.
4. `mergePreparedResults` groups by `canonicalId` and therefore publishes a `ModelDoc` whose
   `modelId` **is** the pointer.
5. `buildCatalogCandidateV3:105-116` computes
   `mergedModels.filter(m => isMistralModel(m) && isMutableMistralPointerV3(m.modelId))` and
   throws `mutable Mistral pointers cannot be canonical models: ...` unconditionally.
6. `publishCatalogV3` (`catalog-v3-publication.ts:103-128`) catches **only**
   `CatalogDeliberateDiffApprovalRequiredV3`; a plain `Error` rethrows, so no candidate is
   built, nothing is staged, nothing is activated, and `runCatalogV3Collection` errors out.

**Their own tests document steps 3-4 as the intended new behaviour.** The test formerly
called "breaks alias cycles using the strongest canonical evidence" was renamed to
"does not collapse circular mutable-only Mistral evidence" and its assertion inverted from
`expect(docs).toHaveLength(1); expect(docs[0].modelId).toBe("mistral-ocr-2505")` to
`expect(docs.map(d => d.modelId).sort()).toEqual(["mistral-ocr-2505", "mistral-ocr-latest"])`
— a `mistral-api` row for `mistral-ocr-latest`, an id that is **not** in the reviewed seven,
now yields a canonical model called `mistral-ocr-latest`. That test calls `mergeResults` and
stops there. No test carries that same input into `buildCatalogCandidateV3`, which is the
only place the two halves meet — and where it throws.

**The live-roster premise.** This is fatal only if Mistral's API actually serves pointers
outside the seven. Three independent pieces of evidence from their own repo say it does:
`collectors/scraper/mistral-model-pages.test.ts:213` is a captured model-page fixture whose
copy-to-clipboard API id is `mistral-ocr-latest`;
`collectors/scraper/mistral-pricing.test.ts:79` is a captured pricing payload whose
`api_endpoint` values include `mistral-small-latest` and `codestral-latest`; and the repo
references `devstral-small-latest`, `devstral-latest`, `mistral-tiny-latest`,
`mistral-vibe-cli-latest`, and `voxtral-mini-latest` besides. None of those is a key of the
seven-entry map. I verified by reading `canonicalizeMistralModelId` that only three pointers
get rewritten to a dated id by ingress (`mistral-medium-latest`, `voxtral-mini-latest`,
`voxtral-mini-tts-latest`); everything else stays mutable. I also verified the seven reviewed
dated targets are fixed points of `canonicalizeModelId`, so the reviewed path itself is
self-consistent — the problem is only the *set*, not the *rule*.

**Concrete failure scenario.** 02:00 UTC. `MistralCollector` returns its usual rows
including `codestral-latest` and `mistral-ocr-latest`. Neither is in the reviewed map, so
both keep mutable canonical ids; the owner-page rows that used to fold them are now ignored.
`buildCatalogCandidateV3` throws `mutable Mistral pointers cannot be canonical models:
codestral-latest, mistral-ocr-latest`. `collectModelCatalog` errors. **No generation is
produced — not even a pending one.** Identical at 05:00, 08:00, and so on. The active
generation stays served, so claudish keeps getting well-formed 200s with a `generationId`
that never advances; within 24 hours every live-roster plan (`opencode-go`, `ollama-cloud`,
both Alibaba token plans, `routing-run`, `streamlake-kwaikat-coding-plan`) decays to
`rosterCoverage: {status:"unknown", reason:"expired"}` while new models never appear. This is
strictly worse than the HIGH-1 freeze it replaced, which at least sealed a pending candidate
a human could approve.

**Contradiction inside the commit.** `subscription-alias-validation.test.ts:114-131` (added
by this commit) asserts the projection for serving evidence pairing canonical
`mistral-ocr-2505-completion` with observed `mistral-ocr-latest` — a pairing the new merger
path can no longer produce, because that pointer is never remapped onto a dated target. One
half of the commit tests a pairing the other half makes unreachable while also making it
fatal.

**Suggestion.** Either (a) let owner-observed dated evidence resolve a pointer generically —
the pointer-to-dated pair asserted by `mistral-model-pages-scrape` or
`mistral-pricing-scrape` for the *same owner* is the same class of evidence the reviewed
table encodes by hand — and keep the hard throw only for a pointer with no owner-observed
target at all; or (b) keep the table-only policy but make the unresolved case **drop the
pointer row** (with a recorded violation) instead of aborting the generation, so one vendor's
unreviewed alias cannot take down the entire catalog. Whichever you choose, add the missing
integration test: feed `buildCatalogCandidateV3` a `mistral-api` roster containing a pointer
that is *not* in the table and assert the intended outcome. That test is the one that would
have caught this.

### HIGH-1 (new) — The dangling-supplemental cleanup uses the pre-retention model set, so it silently strips a legitimate plan inclusion from a model the same generation publishes (a)

**Locations:** `catalog-v3-builder.ts:93` (`mergedModelIds`), `:96-101` (passed to
`applyRosterEvidenceToPlansV3`), `:187-208` (active-model retention), `:212`
(`projectSubscriptionPlanMembershipV3`); the entry-level and inclusion-level `modelIds.has(...)`
tests in `applyRosterEvidenceToPlansV3`.

**Problem.** Two different "does this model exist?" answers are used in one generation.
`mergedModelIds` is built at `:93` from `input.mergedModels` — this run's fresh merge only —
and is the set the new cleanup consults. But the **published** model set is assembled later
at `:187-208`, where the builder deliberately re-adds every active-generation model that is
missing from the fresh merge and whose sources did not certify completeness, stamping it
`dataFreshnessWarning: true`. So a model can be absent from `mergedModelIds` and present in
`candidate.models`. For that model the cleanup fires: its supplemental inclusion is dropped
as "dangling" even though the very same candidate publishes it. `:212`
`projectSubscriptionPlanMembershipV3` then derives `subscriptionPlanIds` from the pruned
inclusions, so the membership disappears too — and because the inclusion is gone, the guard
that would have shouted (`plan ... inclusion references missing model ...`) never fires. The
loud failure I reported has become a silent one.

**Concrete failure scenario, with the wrong output.** `gpt-5.5-codex` is listed by the
OpenAI Codex public registry and, being Codex-only, is reported by no aggregator — the
`openai-api`/codex collectors are its sole source. One run, that collector returns a
transient 500. `input.mergedModels` therefore lacks `gpt-5.5-codex`, so `mergedModelIds`
lacks it. The Codex supplemental roster is fine (or carried forward), and its entry names
`gpt-5.5-codex`, so `supplementalEntryKeys` contains that provider/external pair and the
inclusion is pruned. Retention at `:187-208` then re-adds the model with
`dataFreshnessWarning: true`. The generation activates cleanly. **Published output:
`gpt-5.5-codex` present, callable, and with no `openai-codex` in `subscriptionPlanIds`; the
`openai-codex` plan lists one fewer member.** On our side a `cx@gpt-5.5-codex` request is no
longer recognised as plan-included, so the model is priced per-token and accrues spend for a
user on a flat-rate Codex subscription — the exact money-costing under-report you asked me to
watch for. It self-heals on the next successful collection, which makes it harder to notice,
not less expensive.

**Why this is the same pattern.** The rule ("drop a supplemental positive whose target no
longer exists") is right. Its input — "the set of models that exist" — is read one stage too
early, from the set that is known to be incomplete precisely in the scenario the rule fires in.

**Suggestion.** Compute the cleanup against the final published id set, or at minimum
`mergedModelIds` unioned with the active model ids that retention will re-add. The simplest
correct shape is to move the inclusion pruning after `:208` and pass
`new Set(models.map(m => m.modelId))`. Then add the missing test: an active generation whose
model is absent from the next run's `mergedModels` but retained by `:187-208`, asserting the
Codex inclusion and `subscriptionPlanIds` both **survive**.

### MEDIUM-1 — For the three pointers ingress already rewrites, the "keep it visibly mutable" fallback does the opposite, and a pointer alone can still manufacture a dated canonical model (a)

**Locations:** `applyReviewedMistralPointerTargets`'s fallback branch (`merger.ts` at
`d7acfd7`); `schema-runtime.ts:420-441` `canonicalizeMistralModelId`;
`mistral-identity-policy.ts:22-29`.

The fallback's own comment says "Ingress canonicalizers ... may not turn a moving API pointer
into catalog identity. Keep it visibly mutable so the v3 candidate gate can reject it" — and
then implements that by calling `canonicalizeModelId(raw.externalId)`, i.e. **the ingress
canonicalizer it just declared untrustworthy**. For the three pointers that have a hardcoded
rule there, the result is a dated id, not a mutable one:
`mistral-medium-latest` to `mistral-medium-2604`, `voxtral-mini-latest` to
`voxtral-mini-2602`, `voxtral-mini-tts-latest` to `voxtral-mini-tts-2603`.

Consequences for `mistral-medium-latest`, which is **not** a key of the reviewed map:

- If no owner source observes the dated id this run, the pointer row alone creates the
  canonical model `mistral-medium-2604`, carrying the pointer's context window, capabilities
  and description. Section 2.2's "mutable pointers cannot manufacture canonical identity" is
  satisfied in letter (the published id is dated) and broken in substance. The route is safe —
  dated canonical plus `-latest` external hits the third guard, giving `unknown` — so no
  callable moving target reaches us; the defect is in identity and metadata provenance.
- The reason is also wrong per the reviewed table: this pairing publishes
  `mutable_pointer_only`, while section 4.2 assigns `mistral-medium-2604` the reason
  `identity_conflict` (its reviewed pointer is `magistral-medium-latest`). The commit thus
  contains two contradicting reviewed statements about the same model: the canonicalizer says
  `mistral-medium-latest` *is* `mistral-medium-2604`, and the quarantine table says that
  model's pointer is a Magistral id.

**Suggestion.** In the fallback, use the literal normalized `externalId` (lowercase and trim
only) rather than `canonicalizeModelId`, so the comment becomes true; then decide
`mistral-medium-latest`'s reviewed target explicitly — either add it to the table with a
reason, or delete the stale canonicalizer rule. Whichever way, both statements should live in
one place. Note the interaction with CRITICAL-1: making the fallback honest here *adds* one
more id to the set that blocks generation, so fix CRITICAL-1 first.

### MEDIUM-2 — The deliberate gate still fires on order-only churn, which reintroduces the HIGH-1 freeze whenever an upstream reorders a list (a for the code, (b)/(c) for the trigger)

`semanticCandidate` sorts the five **top-level** arrays (`models` by `modelId`, `plans` by
`id`, `rosters` by `rosterId`, `redirects` by a composite key, `changes` by `modelId`), but
`deliberateRoster` (`catalog-v3-deliberate-diff.ts:143-150`) maps `entries` without sorting
them, and plan `inclusions` are left in `dedupeInclusions([...retained, ...rosterInclusions])`
order. So two collections with identical content but a different upstream ordering produce
different canonical JSON for `rosters` and `plans`, `changed` becomes `true`, and activation
is refused pending an operator digest — the same silent freeze as HIGH-1, narrowed from
"every run" to "any run where an upstream list order changes".

Whether that happens is a property of the upstreams I cannot read from here: a JSON array
from the Codex registry is probably stable, whereas a roster derived from an object/map
iteration or a scraped table with re-ranked rows is not. Supplemental merging appends carried
entries after incoming ones (visible in `catalog-v3-builder.test.ts:327-331`, which expects
`[gpt-5.4-mini, gpt-5.5]` — incoming then carried), so the ordering is a function of upstream
order plus which entries happened to expire. Low cost to close: sort `entries` by
`externalModelId` and `inclusions` by a stable key inside the *projection only*, exactly as
the top-level arrays already are. The persisted documents need not change.

### LOW-1 — `prepareCollectorResultsForCatalogV3` re-slices rows positionally, so any future filter silently mis-attributes models to the wrong collector (a)

The function flattens all collector rows, transforms them, then walks a running `offset`
slicing `result.models.length` rows back into each result. That is correct today because both
stages are `.map()`. If either ever filters or expands — which is exactly what a future
"drop unresolved pointer rows" change would do, and what CRITICAL-1's fix may require — the
slices shift and rows are re-attributed to neighbouring collectors. The consequences are
silent and severe, because `collectorId` determines `sourceProviderIdForCollector` and hence
the route a model is published with; a shifted row becomes a wrong but well-formed route.
Key by an explicit index or a per-row collector tag instead of trusting positional
alignment, or assert `preparedRaw.length === allRaw.length` at minimum.

### LOW-2 — The LOW-1 deferral is not recorded in the repo

Covered under item 6 above: correct non-application, no durable record. Two lines beside the
error table in `docs/api-reference.md` would close it.

---

## What I verified, and what I did not reach

**Verified by reading the committed code (a):** `catalog-v3-deliberate-diff.ts` in full and
every schema it projects; `merger.ts`'s new entry points, `applyReviewedMistralPointerTargets`,
`recanonicalizeAliasBackedRawModels`, `isOwnerTopLevelSource`, `COLLECTOR_TO_VENDOR`;
`catalog-v3-builder.ts` `:53-265` and `:360-420`; `applyRosterEvidenceToPlansV3` in full;
`subscription-alias-validation.ts`'s diff and `projectServingEvidence`;
`mistral-identity-policy.ts` in full; `canonicalizeModelId` and every Mistral and PDecimal
canonicalizer it calls; `collectors/api/mistral.ts` `collect()`;
`manual-overrides/engine.ts` `applyManualModelMappings` and `doc-engine.ts`
`applyManualModelDocMappings` (neither drops nor renames a doc, and synthetic rows pass
`validateRawModel`, so they cannot produce a non-canonical serving key);
`enrichVendorRecords` (maps only); `publishCatalogV3`'s error handling; the full
`catalog-v3-cutover.yml` addition; `orchestrator.ts`'s four Mistral collector registrations;
and the deletion set via the commit's tree listing.

**Inferred from their tests (b):** the G1 auto-activation outcome; the seven published
quarantine rows; the pre-remapped reset; the supplemental-cleanup cases; and the live
composition of Mistral's `/v1/models` roster, which I inferred from their captured
model-page and pricing fixtures rather than from the API.

**Could not determine (c):** the actual current contents of
`https://api.mistral.ai/v1/models` — CRITICAL-1's severity rests on it containing at least
one `-latest` id outside the reviewed seven, which their own fixtures indicate but I could
not confirm live (I hold no Mistral key and would not call a paid API from a review). **If
their team dumps that roster and diffs it against the seven-key map, that single command
settles CRITICAL-1 either way.** Also not reached: which manual mapping rules exist in
production Firestore; `catalog-generation.ts`'s write/CAS/retention internals (unchanged by
this commit); the emulator smoke run and their test suite, both deliberately not executed per
the read-only constraint; and the roughly twenty test files untouched by `d7acfd7`.

**Not re-verified because you closed it:** the 426 wire envelope and
`docs/fixtures/catalog-v3-upgrade-required.json`. I did confirm the fixture is now the single
source for their own contract test (`catalog-v3-http.test.ts:14-18, 94`).

## What claudish should do next

1. **Escalate CRITICAL-1 before anything else.** It is a pre-cutover blocker: deployed as-is,
   catalog generation stops on the first scheduled run and we silently serve an ageing
   generation. Ask for the live `/v1/models` id dump as the deciding evidence.
2. **Escalate HIGH-1(new) as a money bug.** It is quiet, self-healing, and drops a flat-rate
   user's plan membership — the failure mode we least want to debug from the client side.
3. **No change to our 426 parser**, and we can now pin our test to their committed fixture
   path instead of a hand-written literal.
4. **Do not build on the assumption that the catalog advances after cutover** until
   CRITICAL-1 is resolved. A frozen `generationId` with well-formed 200s is indistinguishable
   from health on our side; if we want a client-side canary, `generationId` staleness plus
   `rosterCoverage: {status:"unknown", reason:"expired"}` across multiple plans is the signal.
