# Review of the consolidated backend contract position

Date: 2026-09-09  
Reviews: [AGREED_PLAN_backend_contract-20260909.md](/Users/jack/mag/claudish/.claude/worktrees/nok3/ai-docs/reports/AGREED_PLAN_backend_contract-20260909.md)  
Verdict: the main design direction is aligned; correct the factual claim and acceptance criteria below before using this as the implementation specification.

The substantive recommendations now address the earlier review: validated canonical membership, distinct execution routes, conservative Codex authority, explicit freshness, and consistent publication. No further architecture redesign is requested here. These remaining corrections matter because implementers will encode the acceptance criteria as tests.

## 1. The catalog client does join two HTTP responses

The disagreement section at lines 23–37 is incorrect for the inspected `nok3` source. A `queryModels` constant in `model-loader.ts` does not establish how `all-models.json` is populated.

The actual path is in `packages/cli/src/providers/catalog-client.ts`:

- [Line 53](/Users/jack/mag/claudish/.claude/worktrees/nok3/packages/cli/src/providers/catalog-client.ts:53) defines the slim `queryModels` URL.
- [Line 58](/Users/jack/mag/claudish/.claude/worktrees/nok3/packages/cli/src/providers/catalog-client.ts:58) independently defines the `queryPlans` URL.
- [Line 389](/Users/jack/mag/claudish/.claude/worktrees/nok3/packages/cli/src/providers/catalog-client.ts:389) starts `fetchSubscriptionPlans(timeoutMs)`; line 392 separately fetches the slim models.
- [Line 423](/Users/jack/mag/claudish/.claude/worktrees/nok3/packages/cli/src/providers/catalog-client.ts:423) awaits the plans request, then writes `entries: data.models` and `plans` into one disk-cache object.
- [Line 444](/Users/jack/mag/claudish/.claude/worktrees/nok3/packages/cli/src/providers/catalog-client.ts:444) executes the separate plans fetch.

The combined object is a client-created cache, not proof of a combined server response. The original cross-response mismatch remains possible. Consistency within a backend publication remains a separate requirement too.

**Replace the disagreement section with:**

> Claudish currently fetches slim models and plans separately in `catalog-client.ts`, then combines them in `all-models.json`. Matching publication revisions must protect that join. Backend publication/read semantics must also prevent a response from advertising completeness over partially published data. A future combined endpoint may simplify the client join, but that is an implementation change, not current behavior.

Restore the regression case for model revision A plus plan revision B with an unchanged route-registry version. Test the actual cache builder, not only the recommended-model loader.

## 2. Acceptance criterion 8 reintroduces redirects into aggregator rows

[Criterion 8](/Users/jack/mag/claudish/.claude/worktrees/nok3/ai-docs/reports/AGREED_PLAN_backend_contract-20260909.md:347) permits a second different-ID row when it is marked as a redirect. The confirmed-design section explicitly keeps redirects separate from aliases and plan membership. Existing first-match consumers do not become safe merely because a new discriminator is present.

It also removes the previously accepted baseline for legitimate existing alternative IDs. A second wire ID is not necessarily a redirect, and must not be relabeled to satisfy a test.

**Replace criterion 8 with:**

> Redirects appear only in the dedicated redirect representation and never in normal aggregator rows. Semantically identical duplicate rows are consolidated. Existing distinct-ID groups remain in a reviewed frozen baseline until classified, with no new unapproved ambiguous selectable groups. Known alternatives are not automatically classified as redirects.

The client ranking task should select only among explicitly valid equivalent alternatives. Ranking is not a substitute for proving model identity or resolving a moving alias's target.

## 3. Acceptance criterion 11 preserves the false-exclusion bug

[Item 4](/Users/jack/mag/claudish/.claude/worktrees/nok3/ai-docs/reports/AGREED_PLAN_backend_contract-20260909.md:183) correctly requires unknown when exclusion lacks coverage evidence. [Criterion 11](/Users/jack/mag/claudish/.claude/worktrees/nok3/ai-docs/reports/AGREED_PLAN_backend_contract-20260909.md:354) instead requires exact old routing behavior.

Those are incompatible: [the existing legacy branch](/Users/jack/mag/claudish/.claude/worktrees/nok3/packages/cli/src/adapters/model-catalog.ts:307) can produce `not-served` without the new evidence. Old-cache readability and unchanged exclusion decisions are different requirements.

**Replace criterion 11 with:**

> A new client can read caches containing none of the new fields. Existing positive identity mappings remain usable, but missing coverage evidence cannot independently justify a negative availability verdict. Returning to an older response format during rollback preserves this conservative rule. Old installed clients are tested for response readability; their existing routing defects are not claimed fixed by backend publication.

## 4. Acceptance criterion 9 needs an explicit evidence state

[Criterion 9](/Users/jack/mag/claudish/.claude/worktrees/nok3/ai-docs/reports/AGREED_PLAN_backend_contract-20260909.md:352) requires `qwen3.5-plus` to stay unknown for `qwen-cloud` without specifying plan binding or coverage. That makes the transitional vendor-wide guard permanent.

**Replace criterion 9 with two fixtures:**

> With unknown plan association, incomplete/expired coverage, or mismatched membership revisions, availability remains unknown.
>
> With a verified Token Plan Individual binding and a fresh, exhaustive, matching plan roster that excludes the requested model, availability is not-served for that plan. The unrelated unsupported Alibaba Coding Plan does not suppress that scoped verdict.

Use frozen fixture membership to establish the expected verdict; do not make the test depend on whatever a live vendor happens to serve on the test date.

## 5. Narrow two backend-only acceptance claims

- Criterion 2 should say: **a Team-only model is absent from Individual's published canonical membership**. Whether an Individual holder is routed through it must also be tested in Claudish with the appropriate account/credential binding.
- Criterion 4 can prove **distinct route keys and consistent declared authentication/billing scope** in a backend emulator. Proving that actual credentials cannot cross execution paths requires the client adapter tests. Keep both checks, with the correct owner.

## Additional scope clarification

Keep the new Mistral observations as a separately tracked evidence check. The consolidated position already acknowledges the possible family mismatch is unverified. Do not require invented dated wire IDs, infer identity from similar names, or silently treat moving aliases as immutable models. If a wrong-family mapping is confirmed, repair it with exact provider evidence and its own regression fixture.

The source inspection above is sufficient to resolve the disputed fetch mechanism. No live model calls were made, and no application code or implementation plan was changed in this review.
