# Proposed fix for subscription routing and model identity

For: Claudish developer and Models Index developer  
Date: 2026-09-09  
Responds to: `BACKEND_TASKS-20260904.md` in the Claudish `nok3` worktree  
Status: design recommendation; implementation and client endpoint behavior still need source verification

## Recommendation

The report identifies a real problem: incomplete catalog information can remove a subscription route and expose a user to metered usage. Fix the shared contract and the client's treatment of uncertainty before expanding aliases.

Keep four facts separate:

1. **Identity:** which model and execution variant does this provider's wire ID represent?
2. **Plan coverage:** which models does this specific commercial plan include?
3. **Client capability:** can this installed client execute the route and authentication flow?
4. **Account access:** does this user's credential grant access through that endpoint now?

None of these alone proves the others. A route also does not guarantee zero incremental cost: subscription overages can be metered.

## 1. Scope coverage to the configured plan and endpoint

Do not infer a provider-wide roster by unioning every plan with the same vendor or `providerUid`. A sibling plan's published roster cannot prove that the user's plan excludes a model. Likewise, inclusion in a sibling plan cannot prove the user has access.

Bind each configured credential to an explicit route and, when known, its plan ID. Keep an unknown plan association unknown. Endpoint and authentication identity matter even when two products use the same key prefix.

This is particularly relevant to the suggested Alibaba fix:

| Product | Documented OpenAI-compatible base URL |
|---|---|
| Alibaba AI Coding Plan | `https://coding-intl.dashscope.aliyuncs.com/v1` |
| QwenCloud Token Plan Individual | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |

Sources checked on September 9: [Alibaba Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan), [QwenCloud Token Plan quick start](https://docs.qwencloud.com/token-plan/personal/token-plan-personal-quickstart).

Before assigning `alibaba-ai-coding-plan` to `qwen-cloud`, inspect which endpoint and credentials that Claudish adapter actually uses. If it supports only Token Plan, implement a distinct route or explicit endpoint configuration for Coding Plan. Never silently retarget an existing credential. Sharing adapter code is fine; merging the two products' entitlement is not.

## 2. Make missing information explicit

Extend the existing plan contract additively. Agree on final field names with the backend developer; the semantics below matter more than the spelling.

| Field or concept | Required meaning |
|---|---|
| Existing `routing` | Stable route identity, prefix, and relevant endpoint/authentication profile. Presence describes the route, not account entitlement. |
| Proposed `routingStatus` | `supported`, `unsupported`, or `unknown`, explicitly scoped to Claudish. Missing in an older response means `unknown`. |
| Existing `modelDiscovery` | Where availability is discovered: catalog, client, or hybrid. This is not evidence that a published list is complete. |
| Proposed roster coverage | `complete`, `partial`, or `unknown`, plus the source and time of the last successful roster verification. |
| Client capability registry | Which route identities the installed version can execute. A backend-supported route may still be unsupported by an older client. |

Only publish `complete` when the source establishes an exhaustive roster for that plan and the backend has successfully processed it. A marketing list of highlighted models is insufficient. A nonempty response or freshly served cache is also insufficient.

Preserve the last successful data on collection failure, but expose its age and failed refresh state. Expired coverage must stop supporting definitive negative verdicts. Do not turn a timeout or empty partial response into an empty authoritative roster.

## 3. Use three availability verdicts and a separate billing policy

The resolver should return `available`, `unavailable`, or `unknown`, with an inspectable reason and evidence scope.

| Evidence | Result |
|---|---|
| Model is in an authoritative account roster for the configured credential and endpoint | Available through that route, subject to quota and billing policy |
| Model is absent from a fresh, exhaustive roster for the user's known plan or account, with no unresolved scope mismatch | Unavailable in that scope |
| Partial data, stale data, missing routing metadata, unresolved plan association, or discovery failure | Unknown |

An unavailable result should describe its scope: absent from a plan is different from unsupported by the client or rejected by the endpoint.

When availability is unknown, retain the candidate only if the client has an executable adapter and a credential explicitly configured for that route. Use an existing supported discovery mechanism, or attempt the request only where the endpoint and the user's configured policy permit it. Do not invent a route or silently change endpoints.

Unknown subscription coverage must not itself authorize metered fallback. Respect an existing explicit user fallback preference. If metered fallback has not been authorized, stop with a useful explanation and let the user configure it. Reuse existing settings where possible rather than introducing another competing policy system. Do not add repeated prompts for users who have already chosen their policy.

Expose the reason in route diagnostics, for example: `Subscription coverage unknown: configured plan could not be identified; metered fallback disabled.`

## 4. Preserve model identity when adding aliases

Keep exact mappings provider- and route-scoped. The same wire ID may identify different models on different services. A mapping should resolve a wire ID to a canonical model and, where necessary, an execution variant such as reasoning effort or context size.

Continue using `aggregators[].externalId` for verified mappings and the existing variant mechanism where its consumer supports the required semantics. Do not manufacture public serving routes merely to enrich models discovered by a signed-in client. For account-specific providers, attach identity metadata to the locally discovered roster; a central alias does not establish entitlement.

Treat provider redirects separately from identity aliases. Z.ai currently documents that `GLM-4.7` requests execute `GLM-5.3-Flash`, while `GLM-5.2` and `GLM-5.1` requests execute `GLM-5.3`. Do not publish those as coverage for the original models. If exposing compatibility IDs, record and display the actual execution target. Source: [Z.ai Coding Plan overview](https://docs.z.ai/devpack/overview), checked September 9.

For Devin and similar providers, prioritize mappings backed by authoritative identity evidence. Keep the existing conservative no-match behavior for ambiguous IDs. An observed roster ID alone does not establish its underlying model identity.

## 5. Avoid another ambiguous provider-name mapping

The backend may publish a stable route ID or an explicit Claudish mapping, but omission must mean unknown, not unsupported. The installed client's registry remains responsible for determining whether it can build that route.

Prefer one maintained provider/route registry referenced by catalog rows over duplicating client-specific names on every aggregator row. If `providerUid` is added to rows for compatibility, derive it from that registry and test the mapping. Handle unknown routes visibly in diagnostics rather than silently discarding them.

## 6. Deliver in a small sequence

1. **Client safety:** preserve uncertainty, scope roster decisions to the configured plan/endpoint, and ensure metered fallback follows the user's explicit policy. Keep legacy missing fields conservative.
2. **Backend contract:** publish explicit routing status and coverage completeness, with validation that prevents partial collection from publishing definitive exclusions.
3. **Alibaba integration:** verify the adapter, then publish the correct plan-to-route mapping and refresh that plan's exact roster.
4. **Identity coverage:** add independently verified subscription aliases without converting account observations into universal availability.
5. **Maintenance:** validate aliases against suitable provider rosters during existing collection runs. Report scoped discrepancies; authentication failures and incomplete responses must not delete mappings.
6. **Vocabulary cleanup:** add structured canonical model references while preserving existing `includedModels` display text and compatibility. Represent families and unresolved entries explicitly instead of forcing them into model IDs.

For the Codex roster concern, verify against subscription-specific sources. General OpenAI API availability is not proof of Codex subscription access; do not add historical models solely because they still have an API catalog entry.

## Acceptance checks

- A missing or partial sibling plan cannot remove the user's subscription candidate.
- A model included only in a sibling plan cannot grant the user coverage.
- Alibaba Coding Plan credentials stay on their configured Coding Plan endpoint; Token Plan credentials stay on Token Plan.
- Missing new contract fields in old caches produce unknown coverage, not exclusion.
- Failed or incomplete discovery cannot create an authoritative empty roster.
- Unknown routes produce an actionable diagnostic; they do not disappear silently.
- Unknown subscription coverage cannot trigger metered fallback unless the existing user policy authorizes it.
- Explicitly authorized metered fallback continues to work.
- Redirected wire IDs report the model that actually executes.
- Ambiguous cross-provider IDs cannot enrich or route to the wrong model.

Validate these at the resolver and contract boundaries, then run the relevant existing suites. Verify the deployed plans/catalog and the consuming Claudish behavior separately before calling the fix complete. A backend schema change alone does not establish changed client behavior.
