# Reply to Claudish Feedback — Catalog Contract v3

**Feedback reviewed:** `/Users/jack/mag/claudish/.claude/worktrees/nok3/ai-docs/reports/FEEDBACK_catalog_contract_v3-20260909.md`  
**Replacement plan:** `/Users/jack/mag/models-index/.claude/worktrees/new-subscriptin-model/ai-docs/final-catalog-v3-plan.md`  
**Disposition:** all substantive findings are accepted; two requested outcomes are qualified at their actual evidence/ownership boundaries. No product code or deployment is part of this response.

## Decision vocabulary

- **Accepted:** incorporated as stated.
- **Accepted with qualification:** the underlying issue is accepted, but the evidence or repository boundary does not support the full requested guarantee.
- **Rejected:** not incorporated because source evidence contradicts it or it violates the clean-v3 decision.

No feedback section is rejected wholesale.

## A. Confirmed decisions

These remain fixed and are not reopened.

| Feedback item | Decision | Result in replacement plan |
|---|---|---|
| Only canonical and mapped inclusions create membership | Accepted | `ModelInclusionV3` is the sole membership input. Family/display/prose/qualifier rows cannot carry canonical membership. Raw collector and manual-override membership writes are forbidden. |
| `(routeId, routeProfileId)` separates provider identity from endpoint/credential silo | Accepted | `RouteBindingV3` remains required for supported routes. Direct and subscription profiles have distinct endpoint and credential IDs. |
| Immutable generations, sealed SHA-256 manifest, CAS activation, pinned pagination | Accepted | Preserved with create-only writes, readback, deterministic hashing, immutable activation, pinning, rollback, and retention. |
| Read-time roster coverage/expiry | Accepted | Preserved. Expiry immediately removes negative authority even if active generation does not change. |
| Redirects are separate evidence-bearing records | Accepted | `ProviderModelRedirectV3` remains separate from memberships and aliases. GLM redirects remain explicit. |
| Same-target duplicate dedupe; conflicts block activation | Accepted | Preserved as a reconciliation and activation invariant. |
| Canonical provider IDs are `anthropic` and `moonshotai` | Accepted | Strict route enum keeps these names and rejects `native-anthropic` and consumer route ID `kimi`. |

Evidence agreement: current `subscription-plan-membership.ts` performs a string/alias join; current v2 plan and aggregator shapes in `schema.ts` permit the ambiguous states the discriminated v3 contracts remove. The replacement plan continues to delete the defect classes instead of adding v2 guards.

## B. Open item 1 — Codex roster authority

### Decision: Accepted

The plan now changes `openai-codex` from `catalog` to `hybrid`.

Source evidence:

- `functions/src/collectors/scraper/openai-codex-models.ts` selects public rows with:

  ```ts
  model.supported_in_api === true && model.visibility !== "hide"
  ```

- The source is the public checked-in Codex model registry. That predicate establishes public API visibility/eligibility. It does not establish exhaustive entitlement for a user's ChatGPT/Codex subscription.
- Freshly fetching a source changes observation freshness; it does not broaden the source's authority.

Applied corrections:

1. The public registry is supplemental positive evidence only.
2. A public exact row may add an inclusion.
3. Public absence may not prove non-entitlement, remove membership, produce `not-served`, or satisfy an authoritative roster requirement.
4. Account-authenticated client discovery is the entitlement authority.
5. `OPENAI_CODEX_FALLBACK_MODEL_SLUGS` is removed from the v3 collector path. A hardcoded fallback list establishes neither membership, completeness, nor freshness.
6. The supported route remains `openai/codex-subscription`; route support and roster authority are independent.

This also generalizes the plan's authority rule: authentication determines evidence scope; freshness alone never upgrades public product metadata into account-entitlement evidence.

## C. Open item 2 — seven Mistral moving-pointer rows

### Decision: Accepted with evidence qualification

The safety finding is accepted: a dated canonical model must not publish a mutable pointer as if it were that dated model's exact callable external ID.

Applied contract correction:

- `AggregatorRouteV3` now places `externalModelId` only on the `mapped` branch.
- The `unknown` branch may retain `observedExternalModelId` as non-callable evidence and adds `mutable_pointer_only` and `identity_conflict` reasons.
- A mapped dated Mistral route requires official evidence that the external ID is both callable and identifies that exact dated model.
- A model-card/page slug, date similarity, mutable alias, successor relationship, or inferred naming convention is insufficient.

Seven mandatory audit fixtures are now in the plan:

| Canonical model | Observed pointer | Default safe result |
|---|---|---|
| `codestral-2508` | `mistral-code-fim-latest` | unknown `mutable_pointer_only` |
| `ministral-3-14b-instruct-2512` | `ministral-14b-latest` | unknown `mutable_pointer_only` |
| `ministral-3-3b-instruct-2512` | `ministral-3b-latest` | unknown `mutable_pointer_only` |
| `ministral-3-8b-instruct-2512` | `ministral-8b-latest` | unknown `mutable_pointer_only` |
| `mistral-large-2512` | `mistral-large-latest` | unknown `mutable_pointer_only` |
| `mistral-medium-2604` | `magistral-medium-latest` | drop mapping; unknown `identity_conflict` if retained as evidence |
| `mistral-small-2603` | `magistral-small-latest` | drop mapping; unknown `identity_conflict` if retained as evidence |

The qualification is about exact replacement IDs: this architecture review does not claim a dated wire ID is callable unless a refreshed official API/documented fixture proves it. Where that proof exists at implementation time, the exact ID may be mapped. Otherwise the route remains unknown.

The two family concerns are accepted, not left ambiguous. Repository source separates Mistral and Magistral model-page mappings, and `functions/src/merger-aliases.test.ts` already asserts that `magistral-small-latest` must not alias Mistral Small or `mistral-small-2603`. The replacement plan extends that invariant to both Medium and Small and to serving rows. It does not infer which dated Magistral model a moving pointer currently targets.

## D. Open risk — client propagation and cutover

### D1. The coordination risk

**Decision: Accepted.** “Clients must update” was an assumption and is now a hard external dependency with an owner, test evidence, and cutover gate.

### D2. Cutover date with lead time

**Decision: Accepted with scheduling qualification.** The replacement plan names **2026-10-07 as the no-earlier-than cutover date**, providing 28 days from the feedback date. It is an earliest eligibility date, not deployment authorization. It may move later. The plan forbids moving earlier without a newly reviewed safety decision.

The date remains gated on:

- a Claudish safety release shipping first;
- a v3-capable Claudish build passing emulator acceptance;
- backend tests/build/emulator checks passing;
- deliberate route/recommendation diff review;
- owner acknowledgment of residual never-updated-client risk;
- separate production authorization.

### D3. `contractVersion` on all response shapes

**Decision: Accepted.** Every v3 success and error body, including HTTP 410, 426, and 503, requires `contractVersion: 3`.

The plan adds explicit protocol negotiation:

```http
Accept: application/vnd.models-index.catalog+json;version=3
```

Missing or wrong negotiation receives versioned HTTP 426 `catalog_client_upgrade_required` and never a v3 success payload. A pinned generation no longer retained receives versioned 410 `generation_gone`. Missing/corrupt active state receives versioned 503 `catalog_unavailable`. This is rejection, not dual serving or compatibility.

### D4. Guarantee that any un-updated client fails visibly

**Decision: Accepted as a client requirement; rejected as a backend-only guarantee.**

The current shipped Claudish source prevents the backend from honestly making that guarantee:

- `packages/cli/src/providers/catalog-client.ts:400` returns `{ kind: "fetch_failed", reason: "http_error" }` for any non-2xx response without parsing its body.
- The function documentation at lines 384–386 says failures leave memory and disk caches untouched.
- `warmCatalog` is documented at line 455 as falling through to the disk-read fallback.
- `ensureCatalogReady` at lines 463–465 proceeds with whatever the disk cache holds.

Therefore backend 426 prevents schema-blind parsing of a v3 200 response, but an already installed client can ignore the body and continue with stale v2 cache. The backend cannot update an npm installation, erase its filesystem, or force its resolver to surface an error.

The replacement plan consequently requires a Claudish safety release to detect 426/v3, invalidate or refuse unsafe v2 cache routing, and fail loudly before production cutover. Claudish must prove that behavior. Any claim that all pre-safety-release installations fail visibly would exceed the observed evidence.

This qualification is not a request for compatibility. There is still no v2 success service, parser, converter, old-root read, or dual write in v3.

### D5. Pre-cutover integration target

**Decision: Accepted.** The canonical target is local Firebase Emulator Suite using project ID `demo-models-index`. A real Claudish build can point to emulator Functions using the already present `CLAUDISH_CATALOG_URL` and `CLAUDISH_PLANS_URL` overrides in `packages/cli/src/providers/catalog-client.ts`.

The backend rehearsal builds and activates emulator generations G0 and G1, enabling generation pinning, 410, expiry, rollback, and active/previous tests. A remote staging Firebase project is optional, not assumed, and requires separate authorization and credentials. Production is not a validation environment.

## E. Claudish commitments

### Decision: Recorded as dependencies; not credited as completed

| Claudish commitment | Backend dependency/disposition |
|---|---|
| v3/426 detector with loud failure | Hard pre-cutover gate; client-owned evidence required |
| canonical route IDs; old names user-facing only | Required for v3 acceptance; shortcuts remain outside backend contract |
| `(routeId, routeProfileId)` model | Required to preserve endpoint/credential billing isolation |
| read `plan.route` and `sourceProviderId` | Required before consuming v3 |
| generation pinning and 410/503 handling | Required in shared emulator test |
| consume `rosterCoverage` and remove over-broad roster inference | Required for correct negative verdicts; may ship after initial v3 only if the initial client treats non-complete coverage conservatively |
| independently rank aggregator rows, scope membership to plan, log unresolved routes | Acknowledged as client work outside this backend implementation |

No statement in the replacement plan claims these client changes have been implemented or tested.

Qualification on sequencing: a v3 client cannot safely defer conservative handling of `rosterCoverage`. It may defer removal of old internal code after v3 goes live, but until then it must treat expired/unknown coverage as incapable of proving absence. Otherwise the contract's freshness guarantee would be lost at consumption.

## F. Validation ownership

### F1. Backend-owned tests — Accepted and expanded

The replacement plan adds or preserves:

- strict schema and recursive forbidden-name scans;
- exact 19-plan decision matrix;
- Codex supplemental/hybrid tests and prohibition on fallback-derived membership;
- all seven Mistral pointer/family fixtures;
- Alibaba ten-row evidence and absolute Qwen credential/endpoint isolation;
- GLM redirect separation;
- roster completeness, scope, carry-forward, and read-time expiry;
- immutable generation, hash, readback, CAS, pinning, rollback, and retention tests;
- exact response-body coverage for success, 410, 426, and 503;
- all query/projection modes against `demo-models-index`;
- recommendation/default/search/changelog generation consistency;
- recursive rejection of all forbidden v2 fields/names.

### F2. Client-only validation — Accepted with one wording correction

The four feedback scenarios remain client-owned, with this precise first scenario:

1. A **Claudish safety release**, not an arbitrary never-updated binary, meeting 426 or v3 fails visibly, refuses unsafe v2-cache routing, and does not silently choose metered service.
2. `qwen3.5-plus` remains unknown rather than not-served for unsupported Alibaba Coding Plan routing; Alibaba credentials never reach Qwen Token Plan.
3. GLM 4.5/4.6/4.7 membership and actual execution identity match the approved redirect contract.
4. Recommended-set diff is unchanged or every change is deliberate.

The original wording “an un-updated Claudish ... fails visibly” cannot be proven by backend integration because observed old-client source ignores non-2xx bodies and retains cache. The safety release is the first version that can satisfy that acceptance criterion.

## Summary of plan changes

1. `openai-codex`: `catalog` → `hybrid`; public registry supplemental; fallback membership removed.
2. `AggregatorRouteV3`: callable external ID only on mapped branch; evidence-specific unknown reasons added.
3. Seven Mistral rows receive exact pointer/family audit rules and regression tests.
4. `magistral-*` is explicitly prohibited from routing Mistral Medium/Small.
5. Explicit v3 `Accept` negotiation and versioned 426/410/503 contracts added.
6. `contractVersion: 3` required on every v3 body.
7. `2026-10-07` named as no-earlier-than cutover eligibility date with hard prerequisites.
8. Local `demo-models-index` emulator plus Claudish URL overrides defined as the shared target.
9. Old-client cache behavior documented as a client-owned residual risk rather than a backend guarantee.
10. Backend and client test ownership separated so no unimplemented Claudish work is credited.

## Rejected items

No substantive feedback request is rejected. Two overbroad implications are rejected on observed evidence:

- freshness of a public Codex registry cannot establish exhaustive subscription entitlement;
- a backend 426 cannot by itself guarantee visible failure in every already-installed Claudish version that ignores non-2xx bodies and retains disk cache.

Both rejections strengthen, rather than weaken, the requested data-safety goal.
