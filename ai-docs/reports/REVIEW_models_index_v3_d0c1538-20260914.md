# Follow-up review — models-index v3, commit `d0c1538`

**Reviewer:** claudish client team
**Target:** `d0c1538` ("fix(catalog): close v3 publication blockers"), PR #151, parent `ba4fee1` (a merge of upstream main into the v3 branch; the code change under review is `d7acfd7..d0c1538`)
**Prior reviews:** `REVIEW_models_index_v3_impl-20260913.md` (six findings), `REVIEW_models_index_v3_remediation-20260913.md` (FAIL — CRITICAL-1 + HIGH-1(new))
**Spec:** `~/.claude/plans/gleaming-discovering-marble.md`
**Date:** 2026-09-14
**Mode:** read-only. Nothing in that repo was modified, staged, executed, or tested. Their worktree is still mid-merge with conflict markers on disk, so **every line below was read out of the commit object itself**, never the filesystem. Anyone re-checking this must do the same; the on-disk tree will mislead you.

## Verdict

**CONDITIONAL** — 0 CRITICAL, 1 HIGH, 3 MEDIUM, 2 LOW.

**Both publication blockers from the last round are genuinely closed.** CRITICAL-1's
unconditional `throw` is gone and the replacement is coherent rather than a papering-over:
`candidateModelIds` is now provably the exact final published id set, and every consumer that
previously disagreed about it reads that one set. HIGH-1(new) is fixed in the correct direction
and asserted end-to-end. **This is no longer a pre-cutover blocker.** By the letter of the
severity thresholds (0 CRITICAL, fewer than 3 HIGH) this is a PASS; I am reporting CONDITIONAL
rather than PASS because the one HIGH is a silent partial-catalog outage in precisely the area
the last two rounds were about, and because it is invisible to their own operator alerting as
well as to us.

Nothing here touches the wire contract. Our 426 guard remains correct and pinned to their
committed fixture.

## Item-by-item against what you asked

| # | Question | Result |
|---|---|---|
| — | Can the CRITICAL-1 filter drop a legitimate model? | **YES — HIGH-1 below.** Resolution is real but gated on a ~43-entry hand-maintained slug table, and the drop is unrecorded |
| 1 | exact-ID official-callability for all Mistral routes | **VERIFIED SAFE** — narrower than it reads; no model is dropped and no aggregator route is touched |
| 2 | HIGH-1(new) supplemental reconciliation | **FIXED** for the reported case, asserted; introduces MEDIUM-1 (expiry now strips a live inclusion, untested) |
| 3 | `merger.ts` identity prep survived the 519-line merge | **VERIFIED functionally** — `index.ts:458-489` still prepares once and feeds both consumers |
| 4 | seven §4.2 rows still publish; reasons still split 2/5 | **VERIFIED** (a)(b) — and that seam test's fixtures *are* production-faithful |
| 5 | `canonicalizeModelId` promoting `mistral-medium-latest` | **STILL OPEN — MEDIUM-2**, and now unreachable-by-construction for three pointers |
| 6 | diff projection sorting roster entries / inclusions | **STILL OPEN — MEDIUM-3** |
| 7 | LOW error-vocabulary deferral recorded durably | **STILL OPEN — LOW-1**; a repo-wide search of `docs/` and `CHANGELOG.md` finds nothing |

---

## Findings, most severe first

### HIGH-1 — The quarantine now withholds a Mistral model silently, and the "owner-source-backed" resolution that is supposed to save it is gated on a hand-maintained 43-row slug table. The withholding is invisible to clients *and* to their own provider-drop alert. (a) for every step; (b)/(c) for which pointers occur live

**Locations:** `catalog-v3-builder.ts:109-111` (`publishableMergedModels`), `:402-437`
(`collectServingEvidence` skip), `:440-444`, `:641-665` (`buildModelChangesV3`);
`merger.ts:402-444` (`applyMistralPointerTargets`), `:446-476`
(`sourceBackedMistralPointerTargets`); `collectors/scraper/mistral-model-pages.ts:164-170`,
`:268-302`; `collectors/scraper/mistral-pricing.ts:158-176`, `:426-437`;
`collectors/api/mistral.ts:185`; `index.ts:529-536`.

**The drop is unconditional and unrecorded.** `publishableMergedModels` filters the row out and
`collectServingEvidence` skips it. Neither records a violation. The orphan-route guard at
`:150-155` cannot see it either, because the evidence was skipped rather than orphaned.
`buildModelChangesV3` only diffs active-vs-current, so a pointer that never published produces
no change document. Nothing on the wire says a model was withheld.

**The resolution path is narrower than the contract doc now claims.**
`docs/subscription-routing-contract.md` says pointers resolve "when an owner source binds them
to an immutable identity". In production that requires a **non-`mistral-api`** Mistral-owner row
whose `externalId` **is** the pointer and whose `canonicalId` is a non-pointer
(`merger.ts:446-476`, which discards any row where `target === pointerId`). Two facts collapse
that set:

1. **`mistral-model-pages-scrape` can never satisfy it.** `parseMistralModelPage` returns
   `externalId: modelId, canonicalId: modelId` (`mistral-model-pages.ts:167-168`) — always
   equal. Its `extractModelId` resolves the *slug*, so the OCR-4 page yields `mistral-ocr-4-0`
   for both fields and the page's copy-to-clipboard `mistral-ocr-latest` is discarded. Their own
   `mistral-model-pages.test.ts:210-228` asserts exactly that.
2. **So the only backing source is `mistral-pricing-scrape`**, whose `canonicalId` comes from
   `canonicalModelIdFromMistralCardLink` or `canonicalIdFromPricingRecord`
   (`mistral-pricing.ts:426-437`) → `MISTRAL_PINNED_API_ID_MAP` (7 rows) or
   `canonicalModelIdFromMistralDisplayName` → `findMappedMistralSlugForTitle` →
   **`MISTRAL_MODEL_PAGE_SLUG_ID_MAP`, roughly 43 hand-written slug→dated rows**, plus one
   dashed-decimal regex. On a miss it returns `apiName`, i.e. the pointer — no backing. And
   `mistral-pricing.ts:158` `continue`s on any card whose pricing metrics do not parse, so such
   a card emits no row at all.

So the generic-sounding rule has the same reach as a curated table; it was relocated from
`mistral-identity-policy.ts` into a scraper, not generalised.

**Concrete failure scenario A — a new model is invisible.** Mistral ships a model and
`/v1/models` exposes it as `X-latest` hours or days before the pricing page and slug map carry
it. `reviewedMistralCanonicalIdForPointerV3` misses, `sourceBackedTargets` misses, the fallback
at `merger.ts:437-441` keeps `canonicalId` as the pointer, `mergePreparedResults` publishes a
doc whose `modelId` is the pointer, and `:109-111` drops it. If no other collector produced a
dated doc, **the model is absent from the catalog** behind a well-formed 200 with an advancing
`generationId`. For us: `search_models` never returns it, `mistralai@X` has no catalog row, and
any routing chain that would have included mistralai for that model loses the provider — with
no error and not even an `unknown` evidence row to hint at it.

**Concrete failure scenario B — a published model freezes forever.** The pricing card's layout
changes so the pointer-to-dated binding disappears while the API keeps serving the pointer.
Because `collectors/api/mistral.ts:185` declares
`completeness: { models: "partial", servingRoutes: "partial" }`, `mistral-api` is never in
`completeModelCollectorIds`, so `retainedActiveModelIds` (`:115-130`) always retains the stale
dated doc and `reconcileAggregatorRoutes([], active.aggregators, …)` keeps its stale mistralai
route. The model therefore never disappears — it stops updating. Context window, pricing and
deprecation status freeze at the last run that resolved the pointer. The only signal is
`dataFreshnessWarning: true` on the model doc.

**Their operator alert is blind to it too.** `index.ts:531` calls `buildProviderCounts(merged)`
on the **pre-filter** merged list. A withheld Mistral pointer still counts toward `mistralai`,
so `detectProviderDrops` sees no drop and `alertProviderDrop` never fires. The one mechanism in
the repo built to catch "a provider lost models" runs upstream of the filter that loses them.

**The new test proves the rule, not the path — this is the sixth instance of the pattern.**
`catalog-v3-builder.test.ts` "maps an OCR API pointer through owner evidence and keeps it
non-callable" builds its backing row as
`mistralRawModel("mistral-ocr-4-0", "mistral-ocr-latest", "mistral-model-pages-scrape")` —
`canonicalId` different from `externalId`, from the one collector that can only ever emit them
equal. The assertion is right and the production path it stands for does not exist. Contrast the
seven-row seam test, whose `mistral-model-pages-scrape` fixture uses
`canonicalId === externalId === dated`; that one *is* faithful.

**Suggestion.** Two small changes, in this order. (1) Record the withholding: collect the
filtered ids at `:109-111` and emit them as a candidate-level diagnostic — ideally something a
client can read, at minimum something `alertCatalogResults` reports and something
`buildProviderCounts` is computed *after*. A silent partial is the failure mode this whole
contract exists to remove, and this is now the only unlogged decision in the builder.
(2) Make `parseMistralModelPage` emit the page's copy-to-clipboard API id as `externalId` when
it differs from the slug-derived `canonicalId`. That is precisely the owner-observed
pointer-to-dated pair `sourceBackedMistralPointerTargets` is written to consume, it comes from
Mistral's own page rather than a table, and it would make the OCR test's fixture real. Then add
the test that is still missing: a `mistral-api` pointer with **no** backing at all, asserting
the intended outcome *and* the diagnostic.

### MEDIUM-1 — New this round: roster *expiry* now strips supplemental plan membership even when the model is still published, with no test for that case and no wire signal that distinguishes it from an empty plan (a)

**Location:** `subscription-plan-reconciliation.ts:872-882` — the new first branch inside
`retained`.

At `d7acfd7` an inclusion was stripped only when
`mapped && !modelIds.has(modelId) && key ∈ supplementalEntryKeys`. `d0c1538` adds, ahead of it:

```ts
if (supplementalProvenanceEntryKeys.has(key) && !applicableSupplementalEntryKeys.has(key)) {
  return false;
}
```

That is unconditional on model presence. I tried hard to find a case where it strips a live
inclusion wrongly and could not: `mergeSupplementalRosters:1110-1124` unions **every** unexpired
active entry into the applicable roster, so `key ∈ provenance` and `key ∉ applicable` together
imply either the entry expired or the whole roster failed validation *and* carry-forward
(`reconcileRosterEvidenceV3:760-795`). Both are the intended removal semantics. **The rule is
right.** What is new is its reach.

**Concrete failure scenario.** The OpenAI Codex public-registry collector fails for more than
24h (`LIVE_ROSTER_MAX_AGE_HOURS`). `validateRosterForRequirement(active, …)` now fails on roster
expiry, so nothing is carried, `applicable` is empty for `openai-codex`, and the new branch
strips **every** `provider_model` inclusion — while `retainedActiveModelIds` keeps every Codex
model published and callable. `projectSubscriptionPlanMembershipV3` then derives no
`subscriptionPlanIds`. **Published output: every Codex model present and callable, and the
`openai-codex` plan with zero members.** At `d7acfd7` those inclusions survived, stale but
present. Because the Codex roster is `requiredForActivation: false`, no violation is raised and
the generation activates cleanly. On our side `cx@gpt-5.x` stops being recognised as
plan-included and is priced per-token against a flat-rate Codex subscription — the same money
direction as the HIGH-1(new) you just fixed, relocated from retention to expiry.

**Why we cannot detect it.** `rosterCoverageAt:955-962` returns the constant
`{status: "unknown", reason: "supplemental_only"}` for any plan with no authoritative
requirement, which `openai-codex` is by design. So coverage reads identically before and after,
and an emptied `inclusions` list is indistinguishable on the wire from a genuinely empty plan.

**Untested.** `subscription-plan-reconciliation.test.ts` is unchanged by this commit. The builder
test that covers expiry, "uses an expired active Codex roster as provenance when carrying its
plan", has the carried model **absent** from `mergedModels`, so it passed at `d7acfd7` through
the old model-missing branch and does not distinguish the new one. The case that matters —
provenance key present, roster expired, **model present** — has no assertion anywhere.

**Suggestion.** Either keep the positive and let it decay through coverage — which is what §5's
"expiry removes authority" and `canAuthoritativelyExcludeModelV3` already express: for a
supplemental roster, absence must never harden into not-served — or, if removing on expiry is
the deliberate choice, give the plan a distinguishable state so a client can tell "no members"
from "evidence expired", and add the missing test with the model present.

### MEDIUM-2 — Prior MEDIUM-1 unresolved, and this round made it unreachable by construction for three pointers (a)

**Locations:** `schema-runtime.ts:427-448`; `merger.ts:425-441`, `:459-461`.

`canonicalizeMistralModelId` still promotes `mistral-medium-latest`, `mistral-medium-3.5`,
`-3-5` and `-3.5-128b` to `mistral-medium-2604`; `voxtral-mini-latest` to `voxtral-mini-2602`;
`voxtral-mini-tts-latest` to `voxtral-mini-tts-2603`. This round changed the lookup key to
`pointerId = canonicalizeModelId(raw.externalId)` (`merger.ts:425`), so for those three
`pointerId` is **already the dated id**. Consequences, all read in source:

- `reviewedMistralCanonicalIdForPointerV3(pointerId)` can never match — its keys are pointer
  spellings.
- `sourceBackedMistralPointerTargets` computes its key the same way, so the pricing row for
  `mistral-medium-latest` yields `pointerId === target === mistral-medium-2604` and is discarded
  by `if (target === pointerId) continue` (`:459-461`).
- All three therefore **always** take the fallback `return { ...raw, canonicalId: pointerId }`
  (`:437-441`), which — unlike both resolved branches — does **not** call
  `stripRemappedMutableAliasMetadata`. The pointer row alone publishes a dated canonical model
  carrying the pointer's own `contextWindow`, `pricing`, `capabilities`, `description` and
  `status`, even when no owner source observed the dated id that run. §2.2 holds in letter (the
  published id is dated) and not in substance. The fallback's own comment — "Keep it visibly
  mutable so the v3 candidate gate can reject it" — is still false for exactly these three.
- The route is safe: `subscription-alias-validation.ts:151-155` yields `mutable_pointer_only`.
  But that reason contradicts the reviewed table, which assigns `mistral-medium-2604` the reason
  `identity_conflict` with pointer `magistral-medium-latest`
  (`mistral-identity-policy.ts:22-29`). Two reviewed statements about one model still disagree,
  in two files.

**Suggestion** unchanged: use the literal normalized `externalId` in the fallback, and decide
`mistral-medium-latest`'s target in one place — either add it to the table with a reason, or
delete the stale canonicalizer rule. Note this is now *safe* to do: with CRITICAL-1's throw
replaced by a filter, making the fallback honest no longer risks an outage — it risks a silent
drop, which is HIGH-1's ask.

### MEDIUM-3 — Prior MEDIUM-2 unresolved: the deliberate projection still does not sort roster entries or plan inclusions, so order-only upstream churn still refuses activation (a for the code, (c) for the trigger)

`catalog-v3-deliberate-diff.ts:133-152`: the five top-level arrays are sorted, but
`deliberateRoster` maps `entries` without sorting and `deliberatePlan` only strips
`lastUpdated`. Persistence does not compensate: `createRosterWithSnapshotCount:553-568` maps
`input.entries` in arrival order and never sorts, and only `mergeSupplementalRosters:1130-1132`
sorts — so every roster taken through `rosters.push(cloneRoster(incoming))` keeps upstream
order, which covers the authoritative live rosters. `dedupeInclusions([...retained,
...rosterInclusions])` is unsorted.

**Concrete:** the OpenCode Go roster page re-ranks its table; entry content is byte-identical;
`surfaces.rosters` differs; `buildCatalogCandidateV3` throws
`CatalogDeliberateDiffApprovalRequiredV3`; `publishCatalogV3` stages a pending candidate and
rethrows; `collectModelCatalog` errors. The catalog freezes until an operator supplies a digest —
the original HIGH-1 failure mode, narrowed from "every run" to "any run where an upstream
reorders a list". Still ~4 lines to close, inside the projection only: sort `entries` by
`externalModelId` and `inclusions` by a stable key.

### LOW-1 — The error-vocabulary deferral is still recorded nowhere durable

A case-insensitive search for `405`, `method_not_allowed`, `defer` and `amendment` across
`docs/` and `CHANGELOG.md` at `d0c1538` returns nothing; the same search finds `invalid_cursor`
twice in `docs/api-reference.md`, so the pathspec is sound. The 405-carrying-`catalog_unavailable`
deferral survives only in a PR comment, which leaves the repo when #151 merges. Two lines beside
the error table closes it. No client impact.

### LOW-2 — `prepareCollectorResultsForCatalogV3` still re-slices positionally, and HIGH-1's fix is the change that would break it

`merger.ts:96-112` flattens all rows, transforms, then walks a running `offset` slicing
`result.models.length` back per collector. Still correct at `d0c1538` —
`applyMistralPointerTargets` and `recanonicalizeAliasBackedRawModels` are both `.map()`, and this
round wisely put the quarantine drop in the *builder* on `mergedModels` rather than here.
Flagging it again only because HIGH-1's suggested "drop the row and record it" is exactly the
edit that would shift the slices and silently re-attribute rows to neighbouring collectors, which
decides `sourceProviderIdForCollector` and hence the published route. One line closes it:
`if (preparedRaw.length !== allRaw.length) throw`.

---

## What checks out, with the reasoning

**CRITICAL-1 is properly fixed, not papered over (a).** `publishableMergedModels` (`:109-111`)
replaces the throw, and — the part worth crediting — the `mergedModelIds`/published-set
discrepancy that caused HIGH-1(new) is gone at the root: `candidateModelIds` (`:131-134`) is
`incomingModelIds` unioned with `retainedActiveModelIds`, and the final `models` array is exactly
`publishableMergedModels.map(…)` plus the members of `retainedActiveModelIds` (`:170`, `:202`).
Both `applyRosterEvidenceToPlansV3` (`:139`) and the orphan-route guard (`:154`) now read that one
set. I checked the refactored retention predicate for equivalence rather than trusting it:
`previousSourceIds.length === 0 || previousSourceIds.some(id => !complete.has(id))` is exactly
`!(previousSourceIds.length > 0 && retainedSourceIds.length === 0)`, the condition deleted from
the loop body — no behaviour change. Excluding quarantined actives from retention (`:120`)
correctly prevents a pointer published by an older generation from being carried forward forever.

**HIGH-1(new) is fixed in the right direction and asserted (a)(b).**
`catalog-v3-builder.test.ts` "preserves an unexpired Codex inclusion when its model is retained"
drives two real generations and asserts the inclusion **and** `subscriptionPlanIds` survive when
the model is absent from the fresh merge but re-added by retention. The strip still fires where it
should: "uses an expired active Codex roster as provenance when carrying its plan" asserts
removal, and "keeps a dangling authoritative inclusion fatal" asserts the throw. MEDIUM-1 is the
one new edge the refactor opened.

**The broadened "exact-ID official-callability for all Mistral routes" is safe, and much narrower
than it reads (a).** The entire Mistral block in `projectServingEvidence` is gated on
`evidence.sourceProviderId === "mistralai"` (`subscription-alias-validation.ts:137`), and
`mistral-api` is the only collector that maps to that source provider. Removing
`isDatedMistralModelIdV3` from the last two branches therefore touches **no aggregator route on
any Mistral model** — OpenRouter/Together/Fireworks rows still project `mapped`. What it does
change is that a *non-dated* Mistral canonical (`mistral-ocr-4-0`, `shieldstral-1.0`,
`mistral-embed`) now also needs `externalModelId === canonicalModelId && officialCallableEvidence
=== true` for a callable direct-API route. Since `officialCallableEvidence` is set at
`catalog-v3-builder.ts:429-431` under precisely that condition, the two agree and an exact API id
stays mapped. A failure degrades to `unknown`; it never drops a model. This is the one place where
broadening a reviewed decision into a category-wide rule did **not** repeat CRITICAL-1's mistake,
because the failure mode of the broadened rule is a weaker route rather than a rejected model.

**The `merger.ts` identity preparation survived the merge functionally (a).** `index.ts:458-460`
still calls `prepareCollectorResultsForCatalogV3(collectorResults)` once, and `:473` and `:489`
feed the same `catalogCollectorResults` to `mergePreparedResults` and to the builder's
`collectorResults`. The pre-merge/post-merge identity split cannot reappear. `isMistralModel` was
broadened with `devstral|pixtral|voxtral|leanstral` (`catalog-v3-builder.ts:450-451`); all four
are Mistral families and the predicate is only ever used together with
`isMutableMistralPointerV3`, so I found no non-Mistral model it can capture.

**The seven §4.2 rows still publish, and their seam test is production-faithful (a)(b).**
`catalog-v3-builder.test.ts` "projects every reviewed Mistral API pointer as unknown evidence on
dated models" still runs `prepareCollectorResultsForCatalogV3` then `mergePreparedResults` then
`buildCatalogCandidateV3`, and loops `Object.entries(MISTRAL_POINTER_QUARANTINE_V3)`. Its
`mistral-api` fixture uses `canonicalId === externalId === pointer` and its
`mistral-model-pages-scrape` fixture uses `canonicalId === externalId === dated` — both are the
shapes those collectors actually emit, so unlike the OCR test this one does carry a document
through the seam. `mistral-medium-2604` and `mistral-small-2603` remain `identity_conflict`, the
other five `mutable_pointer_only` (`mistral-identity-policy.ts:1-29`). That the seven reviewed
lookups still resolve after the key became `canonicalizeModelId(externalId)` is (b) — it rests on
their 107/107 claim, since that test is the only thing checking it.

## What I did not reach

- **Their test suite was not run**, per the read-only constraint, and the emulator smoke was not
  executed. All test conclusions come from reading the test source. Their 107/107 and
  1,183/1,183 claims are unverified by me.
- **The live contents of `https://api.mistral.ai/v1/models`.** HIGH-1's frequency — how often a
  pointer arrives with no pricing-card backing — depends on it. Their own fixtures show the
  binding working for `mistral-medium-latest`, `mistral-small-latest`, `codestral-latest`,
  `mistral-ocr-latest` and `devstral-small-latest`, so the common cases are covered today; the
  exposure is new releases and card-layout drift. A dump of that roster diffed against
  `MISTRAL_MODEL_PAGE_SLUG_ID_MAP` plus `MISTRAL_PINNED_API_ID_MAP` settles the severity.
- `catalog-generation.ts` write/CAS/readback/retention internals — unchanged by this commit, and
  still the un-audited half of Priority 3 item 10.
- Which manual mapping rules exist in production Firestore.
- `web/`, the roughly twenty test files untouched by `d0c1538`, and the non-Mistral,
  non-Codex collectors.
- Not re-verified because you closed it: the 426 envelope and
  `docs/fixtures/catalog-v3-upgrade-required.json`.

## What claudish should do next

1. **Ask for HIGH-1's diagnostic before cutover, not the resolution fix.** We can live with
   Mistral pointers being withheld; we cannot live with not knowing. A candidate-level list of
   withheld ids, plus computing `buildProviderCounts` on the post-filter set, are both small and
   convert this from silent to observable.
2. **Raise MEDIUM-1 as a money item.** After 24h of Codex-registry failure the `openai-codex`
   plan publishes with zero members and we cannot tell that from an empty plan. If they decline
   to change the policy we need a distinguishable signal, or we will mis-price `cx@` for
   flat-rate users.
3. **No change to our 426 parser.**
4. **A client-side canary is still worth having**, but its shape has changed: a frozen
   `generationId` no longer indicates the Mistral failure, because the generation now advances
   happily while withholding models. Watch instead for Mistral models carrying
   `dataFreshnessWarning: true` across several generations, and for plans whose `inclusions` drop
   to zero.
