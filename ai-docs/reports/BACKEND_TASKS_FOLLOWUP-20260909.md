# Follow-up on the revised backend routing spec

For: Claudish developer and Models Index developer  
Date: 2026-09-09  
Re: `REPLY_backend_routing_proposal-20260909.md` and the revised `BACKEND_TASKS-20260904.md` in the `nok3` worktree  
Status: revised direction accepted; remaining contract and acceptance-test corrections below. No implementation or live client verification claimed.

The revised direction is sound: Alibaba Coding Plan remains unrouted, identity mappings remain separate from entitlement, redirects get their own representation, and client-specific names belong in a maintained registry. The metered-fallback decision remains with Claudish product ownership and should not be bundled into a backend data change.

I also accept the correction that the three-verdict resolver already exists. The work is to repair its evidence and scope, not introduce another resolver.

## 1. GLM redirects reconfirmed

I reopened the [Z.ai Coding Plan overview](https://docs.z.ai/devpack/overview) on September 9. Its Supported Models section explicitly documents:

| Requested model | Documented execution target |
|---|---|
| GLM-4.7 | GLM-5.3-Flash |
| GLM-5.2 | GLM-5.3 |
| GLM-5.1 | GLM-5.3 |

It names GLM-5.3 and GLM-5.3-Flash as the supported models. This verifies the documentation claim; it is not a credential-specific inference probe. It provides no basis to infer equivalent redirects for GLM-4.5 or GLM-4.6.

Represent these records within the GLM Coding Plan route, with requested ID, canonical execution target, source URL, and verification time. Do not add the original models to plan membership or turn these into global model aliases. Displaying the execution target must not itself create permission to substitute models during route selection.

## 2. The same-vendor guard is still transitional

The revision calls the v9.0.4 guard the correct end state for Alibaba. That does not follow from the endpoint split.

The guard in [model-catalog.ts](/Users/jack/mag/claudish/.claude/worktrees/nok3/packages/cli/src/adapters/model-catalog.ts:361) is at lines 361–370 in the inspected `nok3` checkout. It treats every unrouted plan under the same vendor as a reason to return `unknown` for a routed sibling.

An unsupported Coding Plan adapter says nothing about a known Token Plan account. Once the user is bound to Token Plan Individual and its exact roster is fresh and complete, a model's absence can be conclusive for that plan regardless of whether Coding Plan has an adapter.

Keep the guard while the required evidence is missing. Replace it with plan-, endpoint-, freshness-, and snapshot-scoped checks when those exist. Do not simply remove it upon seeing `routingStatus: unsupported`; that would leave the current plan-union defect intact.

Also update the old guard comments at lines 347–360: they still claim the correct long-term fix is a routing block on every plan, contradicting the accepted revision.

## 3. Acceptance check 4 does not pass for all old caches

The `providerPlans.length === 0` branch covers only one missing-data case. Source inspection shows two additional paths:

- **Legacy cache with no `plans`:** lines 307–314 can return `not-served` when another entry identifies the provider as a legacy subscription, even though no explicit completeness evidence exists.
- **Cache with plans but no new coverage fields:** lines 335–338 accept a single membership row as publication evidence; lines 374–380 can then return `not-served` solely because all selected plans use `modelDiscovery: catalog`.

Change the acceptance-table verdict to incomplete/failing and add fixtures for both paths. Missing coverage evidence should result in `unknown` for exclusion decisions, even when plans and some memberships exist.

The sibling over-coverage finding is also conditional in the current code: union membership becomes `serves` only when a matching aggregator supplies an external ID; otherwise lines 321–326 return `unknown`. Keep the regression fixture explicit about that wire ID so it exercises the dangerous positive-verdict path. The underlying route-as-plan mistake is valid in both cases.

## 4. Completeness must refer to the membership snapshot the client received

The current resolver already notes that `queryPlans` and `queryModels` arrive through separate requests. A plan marked complete from run B can be paired with memberships from run A. Both documents may be individually valid while their join produces a false exclusion.

The contract must carry enough evidence to reject that mismatch. Prefer an existing publication revision if one is available. Otherwise use either:

- a shared membership revision on the plan coverage record and the corresponding model-membership response; or
- a self-contained, exhaustive canonical membership list delivered with that plan's coverage record.

The backend must publish a complete revision only after the source roster and its required canonical memberships are successfully materialized. A client must not conclude absence from a filtered, limited, or incompletely paginated model response. Snapshot identity alone does not make a partial response exhaustive.

Allow a negative verdict only when the selected plan/endpoint matches, coverage is complete and usable, the membership data matches the coverage revision, and the received membership view is exhaustive. Missing or mismatched evidence yields `unknown`.

## 5. Separate last successful completeness from current usability

Agree that a failed required refresh must disable negative conclusions. Preserve the last successful roster and its original verification time, but expose the failed refresh and make effective exclusion coverage unknown until the necessary evidence is restored.

Also include an expiry rule the client can evaluate locally. Otherwise a cached `complete` flag can outlive both a failed backend refresh and the client's ability to fetch the updated status. Do not refresh verification time merely by serving or rewriting cached data.

Scope invalidation to the evidence required for that roster. Failure of an unrelated pricing or description collector should not invalidate successfully verified membership. An unresolved required roster entry should prevent a claim of exhaustive canonical membership, even if the upstream fetch succeeded.

## Implementation boundary and sequence

1. Finalize the additive fields with explicit Claudish scope, completeness evidence, expiry, and membership consistency. Omitted status remains unknown. Mark unsupported only where adapter absence is verified; do not infer it for all seven plans from missing blocks alone.
2. Prepare Claudish readers and tests using contract fixtures. They do not need to wait for production publication to be written. Test old caches and mismatched snapshots as well as new valid data.
3. Publish backend status and coverage metadata with invariant checks; keep Alibaba Coding Plan without a `providerUid`. Preserve data on collection failure while preventing stale exclusions.
4. Verify that the released client consumes the deployed contract and fixes both directions of the sibling-plan error. The unknown-verdict handling and downstream metered-fallback policy remain separate concerns.
5. Add verified redirects and identity mappings, then validation and structured model references. Devin mappings still require independent identity evidence; lack of such evidence is a reason to leave a mapping unresolved.

Add these acceptance cases to the existing list:

- A complete Token Plan Individual roster can exclude a model even while Alibaba Coding Plan is explicitly unsupported, provided the account/endpoint binding is known.
- A legacy cache and a cache with plans but no coverage metadata cannot independently justify exclusion.
- Plan revision B paired with membership revision A yields unknown.
- A limited or filtered membership response cannot establish absence.
- A cached coverage record expires locally even when no refreshed response can be fetched.
- An unrelated collector failure does not invalidate successfully verified membership.

These amendments make the revised proposal suitable for implementation without reviving vendor-wide entitlement or replacing one missing-data heuristic with another.
