# Verification: the models-index v3 reader handoff, against the live catalog

**Date:** 2026-09-19 (checks run 2026-09-18, UTC)
**Handoff verified:** `models-index/docs/reviews/2026-09-19-claudish-v3-reader-handoff.md`, with its evidence in `2026-09-19-catalog-v3-cutover-bug-report.md`
**Method:** live public endpoints, with the v3 `Accept` header, cache bypassed, and every read pinned to one generation. The backend repository was read at the deployed commit `42358be` and never modified.
**Script:** `ai-docs/reports/VERIFY_models_index_v3_handoff-20260919.ts`

## Result

Every backend claim in the handoff holds: **48 of 48 checks pass** against generation `g-20260918181642356-73127622`. The shared Alibaba contract's own promises hold too: **10 of 10**.

The claims about claudish also hold. Released 9.7.1 cannot read v3, Poe's factory is unimplemented, and the Vertex transport exists.

The checks also surfaced three things the reader must do that the handoff does not spell out. Four pieces of claudish work are missing, and one piece of existing, unmerged claudish work conflicts with the handoff. All are listed below.

## Backend claims

| Handoff claim | Live result | Evidence |
|---|---|---|
| Runtime v1.2.84 | ✓ | `queryVersion` → `{"version":"1.2.84","deploymentRevision":"queryversion-00103-zoc"}` |
| Active generation `g-20260918181642356-73127622` | ✓ | every model page, plans, probes and OpenAPI carry it |
| 1,301 models | ✓, **only with `status=all&includeRouteVariants=true`** | see reader requirement R1 |
| 19 plans | ✓ | |
| 30 route profiles | ✓ | `RouteBindingV3` in the live OpenAPI has 30 alternatives |
| 23 verified probe selections | ✓ | `probeModels.data.routes` |
| 7 explicit unavailable reasons | ✓ | 5 × `client_model_selection_required` (Antigravity, SuperGrok, Devin, Qwen Coding Plan, Sakana Fugu subscription); 2 × `no_verified_probe_model` (Poe, Vertex) |
| Contract 3 is required | ✓ | `queryModels`, `queryPlans` and `probeModels` answer 426 `catalog_client_upgrade_required` without the header |
| Generation-pinned pagination | ✓ | the cursor encodes its generation; a cursor plus a different `generationId` → 400 `invalid_cursor`; an unknown generation → 410 `generation_gone`; plans and probes honour `generationId` |
| Twelve subscription bindings | ✓ | all 12 are registered and each appears in exactly one probe map |
| Five gateway profiles | ✓ | OpenRouter 470 connections, Together 239, Fireworks 21 with verified picks; Poe and Vertex are registered with `no_verified_probe_model` |
| Alibaba memberships exactly 10 / 20 / 31 | ✓ | the plan inclusions and the model-side `subscriptionPlanIds` agree |
| Both probe maps, filtered by `routeId` | ✓ | `?routeId=qwen` → 2 routes and 1 unavailable |
| Grok video booleans | ✓ | `grok-imagine-video`: `videoInput:true`, `videoOutput:true`. `grok-imagine-video-1.5`: `videoInput:false`, `videoOutput:true` |
| OpenRouter restored | ✓ | 470 mapped `openrouter/gateway` connections (0 before) |

### The shared contract's own promises

models-index `ai-docs/alibaba-provider-changes.md` makes promises the handoff does not repeat. **10 of 10 pass** on the same generation, via `VERIFY_models_index_v3_contract-20260919.ts`:

| Promise | Live result |
|---|---|
| Coding Plan published as unknown, with no callable route | `routeStatus: unknown`, `routeReason: authenticated_account_roster_required`, no `route` |
| Coding Plan kept out of recommendations and defaults | 0 mentions in `catalog=recommended` and in `queryPluginDefaults` |
| An unknown connection is never callable | 372 unknown rows, 0 with `externalModelId` or `route`, all 372 with `observedExternalModelId`. Reasons: `unsupported_provider` 268, `unverified_mapping` 94, `mutable_pointer_only` 8, `identity_conflict` 2 |
| Every mapped connection is callable | 0 mapped rows without `externalModelId` |
| PAYG is metered, not a subscription record | no plan is bound to `qwen/dashscope-direct` |
| Token Plan Individual and Team stay separate records | two plans, both bound to `qwen/qwencloud-token-plan` |
| One video field per direction, no duplicate | exactly `videoInput` and `videoOutput` |
| Redirects published | 3, all on `z-ai/glm-coding-subscription`, e.g. `GLM-4.7` → `glm-5.3-flash` |
| Membership coverage on every plan | present on all 19 |

Not a failure, but worth a look given the rule that static values match: the contract calls the products "Alibaba Coding Plan" and "Alibaba Token Plan", while the plan records are named "Alibaba Cloud Model Studio Coding Plan", "QwenCloud Token Plan Individual" and "QwenCloud Token Plan Team Edition". Those are commercial plan names rather than product labels, so they may be intended.

### The six wire translations

Every connection on these profiles publishes an exact `externalModelId`. Examples:

| Profile | Connections | Translate | Examples |
|---|---|---|---|
| `minimax/direct-api` | 8 | 8 | `minimax-m3` → **`MiniMax-M3`**, `minimax-m2.7` → `MiniMax-M2.7` |
| `ollama/cloud` | 24 | 24 | `kimi-k3` → `kimi-k3:cloud`, `glm-5.3` → `glm-5.3:cloud` |
| `opencode/zen` | 69 | 9 | `muse-spark-1.3` → `muse-spark-1.3-contributor-free` |
| `anthropic/direct-api` | 11 | 3 | `claude-opus-4-5` → `claude-opus-4-5-20251101` |
| `x-ai/direct-api` | 7 | 3 | `grok-4.20` → `grok-4.20-0309-reasoning` |
| `deepseek/direct-api` | 2 | 1 | `deepseek-v4.1-flash` → `deepseek-flash` |

## claudish's own functions against the live v3

`VERIFY_claudish_functions_vs_v3-20260919.ts` calls claudish's catalog functions from source and compares each answer with what the live generation publishes. It covers 34 cases in six areas: reading the catalog, wire-id translation, bare-name routing, subscription coverage, model metadata, and the first model Test All tries.

| User state | Correct | Wrong |
|---|---|---|
| **9.7.x after one launch** (the contract sentinel is set) | **0** | **34** |
| **9.6.x** (no guard; reads the v2 cache frozen at the cutover) | 18 | 16 |

**9.7.x is worse than 9.6.x.** The guard refuses a cache that is mostly still right, so bare-name routing, translation, coverage and metadata all stop at once. Contract line 21 says the opposite: report the state and keep routing. The reader release fixes this.

What the frozen v2 cache gets **wrong** (all of it is fixed by reading v3):

- **A Fireworks id sent to OpenRouter.** A bare `qwen3.8-max` falls back to `openrouter` with `accounts/fireworks/models/qwen3p8-max`. v3 has no OpenRouter connection for that model at all, so the call cannot succeed.
- **Untranslated subscription ids:** `minimax-coding` sends `minimax-m3` for `MiniMax-M3`; `glm-coding` sends `glm-5.3` for `GLM-5.3` and `glm-5.3-flash` for `GLM-5.3-Flash`; `opencode-zen-go` sends `deepseek-v4.1-flash`, which v3 does publish, alongside `deepseek-flash`.
- **Coverage unknown** for the GLM Coding Plan and OpenCode Go, although v3 lists the models as members.
- **Video capability absent:** no `videoInput` for `grok-imagine-video` or `grok-imagine-video-1.5`.
- **Stale first picks for Test All:** `gpt-5.6-luna` where v3 says `gpt-6-astra`, `kimi-for-coding` where v3 says `k3`.

What it gets **right** and the reader must keep: translation through model connections (`kimi-k3` → `k3` on Kimi Coding, `kimi-k3:cloud` on Ollama Cloud, `MiniMax-M3` on the MiniMax API, `deepseek-flash`, `grok-4.20-0309-reasoning`, `anthropic/claude-opus-4.5` on OpenRouter), coverage for Kimi Coding, Codex and the Token Plan, context windows, and picker search.

Two facts about the published data came out of this, and the reader must handle both:

- **Subscription wire ids can live only in plan inclusions.** The GLM Coding Plan publishes no model connections; its `GLM-5.3` and `GLM-5.3-Flash` exist only as `inclusions[].externalModelId`. A reader that reads connections alone calls those models by their canonical ids.
- **OpenRouter publishes two ids for some models:** the exact id (`moonshotai/kimi-k3`) and a moving pointer (`~moonshotai/kimi-latest`). A pinned model must be called by the exact id. The 9.6.x cache already does this.

## Live validation of PR #266 (2026-09-19)

The backend moved to runtime **1.2.90** and generation **`g-20260919013346169-feffb8ad`** (1,309 models, 24 probe picks, 6 unavailable reasons). It deliberately amended the contract so the Coding Plan is `supported` through `qwen/modelstudio-coding-plan`; its probe pick is `qwen3.7-plus`, one of its own members. Rerun on the new generation: the handoff checks pass except the four counts that moved with it, and the amended contract checks pass 10 of 10. The handoff document still names runtime 1.2.84 and the previous generation.

A v3 reader already exists: **PR #266**, "Claudish 9.8.0: strict catalog v3 reader and three Alibaba products", built in the Codex worktree `claudish-catalog-v3-reader`. Its last runs wrote the v3 cache to the real `~/.claudish/all-models.json` at 12:57:52 local, 87 seconds before its commit.

**Functional check against live v3:** PR #266 answers 30 of 36 cases correctly (9.7.x: 0 of 34). The 6 remaining are real defects:

| # | Defect | Evidence |
|---|---|---|
| 1 | A plan member is missing | The reader fetches `status=all&catalog=slim` without `includeRouteVariants`, so `kimi-code`'s member `kimi-k3-256k`, a route variant, has no model row. |
| 2–3 | OpenRouter called by moving pointer | `kimi-k3` → `~moonshotai/kimi-latest`, `gpt-6-astra` → `~openai/gpt-astra-latest`, although v3 publishes the exact ids. 9.6.x used the exact ids. |
| 4 | A fallback hop that cannot succeed | A bare `qwen3.8-max` falls back to OpenRouter, which v3 does not list as serving it. |
| 5–6 | Video capability not consumed | `videoInput`/`videoOutput` are stored (`all-models-cache.ts:46-47`) and read nowhere. The handoff requires that video output excludes a model from chat. |

**Live Test All with real credentials:**

| | 9.7.1 | PR #266 |
|---|---|---|
| ready | 15 | 13 |
| real 429 quota answers | 3 | 3 (MiniMax Coding, GLM, Sakana Fugu) |
| **Antigravity** | ready | **FAIL: "no probe model: transport does not support discovery"** |
| Token Plan | ready as "Qwen Plan (qc@)" | not set: the key is stored as `QWEN_CLOUD_PLAN_API_KEY`, which has no alias by decision |

The Antigravity failure follows from the new probe map. v3 marks it `client_model_selection_required`, and Test All then relies on endpoint discovery, which the Antigravity transport does not implement. 9.7.1 passed only by trying a stale cached pick. The PR's own report covers Antigravity through `--probe`, not Test All.

**Decisions honoured:** Alibaba identities are exactly `qwen-token-plan`/`qtoken`, `qwen-coding`/`qcode` and `qwen-payg`/`qpay`, with no old name left in the source. There is no billing gate. "Roster" still appears in 7 lines the PR adds.

**Mixed versions on one machine:** the PR writes v3 entries into the same `~/.claudish/all-models.json` older builds read. 9.7.1 code reading that file with no sentinel crashes on every bare-name route with `TypeError: undefined is not an object (evaluating 'entry.sources["openrouter-api"]')`, measured here. 9.7.x is protected while its sentinel stands, and the PR no longer writes or removes it. A 9.6.x process, or any 9.7.x process without the sentinel, crashes after a 9.8.0 run on the same machine. A separate cache file name would remove the risk.

**Not validated live:** Poe and Vertex requests, the three Alibaba products (no stored keys under the new names), metered Zen, and the behaviour of 9.8.0 when a catalog it cannot read arrives (contract line 21).

## Fixes on `fix/v3-reader-gaps` (2026-09-19)

Each fix was checked against the live catalog or a live account, not only by unit tests.

| Defect | Commit | Live evidence |
|---|---|---|
| 1. Route-variant plan member missing | `30f70d4` | 894 rows fetched, 0 plan members without a row |
| 2–3. OpenRouter called by moving pointer | `30f70d4` | `openrouter:moonshotai/kimi-k3`, `openrouter:openai/gpt-6-astra`; a pointer is sent only when the requested id is itself a pointer |
| 4. Fallback hop that cannot succeed | open | part of the routing redesign (catalog-derived chains), waiting for decisions Q1–Q5 |
| 5–6. Video capability not consumed | `492b0e4` | all 43 `videoOutput` models excluded from chat; 86 of 93 video-reading models still offered (the 7 hidden are image and embedding models, excluded by name) |
| Mixed versions share one cache file | `af02ca3` | v3 cache is `cloud-models-catalog-v3.json`, the MCP OpenRouter list is `openrouter-models.json`; a forced warm left `all-models.json` byte-identical |
| Antigravity FAIL in Test All | `4128e07` | the transport now offers the account's own model list; Test All shows Antigravity ready |
| Claude on Antigravity rejects a thinking budget ≥ `max_tokens` (found while fixing the above) | `5fc423c` | `max_tokens` 16000/high and 8000/medium returned 400 before and 200 after |

**The Antigravity probe needed two fixes.** With discovery in place, every probe still returned `400 INVALID_ARGUMENT`. The probe sends effort "minimal", which the Gemini adapter turns into `thinkingBudget: 0` on Gemini 2.5, and Antigravity rejects that. "low" is not a general fix: Antigravity also serves Claude, and a 1024-token budget is not below the probe's 512-token cap. The probe knows the provider, not the model family, so for Antigravity it now sends no effort field. All nine models tried then returned visible text.

| Antigravity model | `minimal` | `low` | no effort field |
|---|---|---|---|
| `gemini-2.5-flash` | 400 | 200 | 200 |
| `gemini-2.5-flash-lite` | 400 | 200 | 200 |
| `gemini-3-flash` | 200 | 200 | 200 |
| `claude-sonnet-4-6` | 200 | 400 | 200 |

**Test All after the fixes (dev build, real credentials):** 15 ready, 3 FAIL. The three are account quota answers, not claudish errors: MiniMax Coding `429` "Plan limit reached", GLM `429` "Out of quota", Sakana Fugu `429` "Out of quota … Prepaid".

**Later on the same branch.** Each entry passed typecheck, lint and the full guarded suite (3,607 pass, 0 fail, 29 live tests skipped).

| Change | Commit | Evidence |
|---|---|---|
| "Roster" retired in code, with a guard test that fails on the word | `ab1fc09`, `5d87942` | 0 hits, including the two NUL-byte files that `grep -I` skips |
| Dropped-subscription notice printed `[claudish] [claudish]` | `eceab30` | live: `[claudish] kimi-coding does not serve kimi-k3 — using Kimi, which bills per token.` |
| Credential readiness is `present` / `absent` / `failed`; a subscription whose credential could not be read gets its own notice | `7127287`, `4362311` | real-credential routes unchanged for 5 models; a locked 1Password with an unrelated `op://` ref reads `absent`, not `failed` |
| "Model not exist" is a model-unsupported error; a 401 names the other Alibaba plans' keys | `fa09cb7` | the hint for a 400 "Model not exist" changed from "Request format may be incompatible" to "Model not supported by this provider" |
| An incomplete provider model list cannot deny; a missing base URL is a recorded failure | `28fc06d` | no configured provider's list is emptied by the rule (11 providers checked live) |
| `qwen-coding` and `qwen-payg` in every hand-written table | `8691eed` | drift test over routing hints and the Routing tab |
| Alibaba docs and reports, without the billing gate | `cc55c1b`, `ab7d0f5`, `9d0e2fa` | |
| Tests for the eight reader-gap fixes | `5d87942` | 30 tests; each fails when its fix is reverted |

**Not ported: the rule that a public model list may never deny (old group D).** It targets the Coding Plan, whose `/v1/models` answers without a credential. In generation `g-20260919013346169-feffb8ad` the Coding Plan is `supported` with a catalog membership of 10 models, so catalog membership drops a non-member before the public list is read, and every member is on the public list. The public list decides alone only when the catalog is missing. There, its denial keeps an unlisted id away from the Coding Plan, which answers `400 Model not exist`, and that error does not advance the routing chain. Porting the rule would reopen that dead end.

**Contract line 21, measured with the dev build.** A dead catalog server prints `WARNING: Catalog refresh failed … Using cached version.`; a `426` prints `Model catalog contract v4 is not supported by this build.`; neither overwrites the cache. With no catalog at all, routing continues and keeps `glm-coding`, `qwen-token-plan`, `openai-codex` and `antigravity` first. One gap: `kimi-k3` loses its Kimi Coding hop. That plan serves the model as `k3`, only the catalog records that `kimi-k3` and `k3` are the same model, and Kimi Coding's own list answers `not-served` for `kimi-k3`. The chain falls to OpenCode Zen Go, another subscription, so billing does not change. Closing the gap without a catalog would mean guessing a name, which the exact-id rule forbids; it is part of the cold-start decision (Q4).

## Reader requirements the verification surfaced

**R1. Read the complete projection.** The default `queryModels` projection returns 1,111 models. It omits 181 deprecated models and 9 route variants:

| Query | `total` |
|---|---|
| default | 1,111 |
| `status=active` | 1,033 |
| `status=all` | 1,292 |
| `status=all&includeRouteVariants=true` | **1,301** |

Plan memberships still point at deprecated models. On the default projection, 12 plan members have **no model row**, for example `kimi-k2.5` and `deepseek-v4-pro` in the Alibaba plans. A reader on the default projection would under-count 11 plans.

**R2. Pages are capped at 200.** A request for `limit=500` returns 200 rows. The complete catalog is 7 pages. Follow `nextCursor` until it is absent.

**R3. Membership is by distinct model.** Plan inclusions can name one canonical model under several wire ids. Anthropic has 22 inclusions for 11 models (dated and undated ids); ollama-cloud, opencode-go and streamlake each have one duplicate. `subscriptionPlanIds` already agrees with the distinct counts for all 19 plans, so use it, as the handoff says.

## Two bindings without a supported plan

These are consistent with the handoff, but the reader must route them by **binding**, not by plan:

- `qwen/modelstudio-coding-plan`: plan `alibaba-ai-coding-plan` is `routeStatus: unknown` with no route. The handoff says public coverage is 10 ids but account access is unknown; 9 connections are mapped.
- `sakana/fugu-subscription`: no plan names it at all. It is registered, and its probe entry is `client_model_selection_required`.

## Claudish: claims and gaps

| Handoff statement about claudish | Result |
|---|---|
| 9.7.1 cannot consume the live contract | ✓ true: no `Accept` header, so every read is a 426 |
| Poe's transport exists but its factory is unimplemented | ✓ true: `createHandler: noHandler("unimplemented", …)` at `provider-definitions.ts:909` |
| Vertex has a project-aware transport | ✓ `createHandler: vertexHandler` |

Missing on `main`, all needed for the handoff's release acceptance:

1. **No Together provider and no Fireworks provider.** The fixture binds `together` and `fireworks`, and dev validation must exercise all five gateway profiles. Each new provider needs entries in both `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES`.
2. **No Coding Plan provider** (`qwen-coding`).
3. **Alibaba names differ from the handoff:**

| Product | Handoff | `main` | branch `worktree-qwen-token-plan` |
|---|---|---|---|
| Coding Plan | `qwen-coding` / `qcode` / `QWEN_CODING_PLAN_API_KEY` | not built | same as the handoff |
| Token Plan | `qwen-token-plan` / `qtoken` / `QWEN_TOKEN_PLAN_API_KEY` | `qwen-cloud` / `qc` / `QWEN_CLOUD_PLAN_API_KEY` | `qwen-cloud` / `qc`, `qtp` / `QWEN_TOKEN_PLAN_API_KEY` + alias `QWEN_CLOUD_PLAN_API_KEY` |
| PAYG | `qwen-payg` / `qpay` / `DASHSCOPE_API_KEY` | `qwen-payg` / `qp`, `dashscope` / `DASHSCOPE_API_KEY` | same as `main` |

The backend portal already shows users `qcode`, `qtoken` and `qpay`. claudish accepts none of them today, which is claudish's defect to fix.

4. **Poe cannot make a request** until its factory exists.

## Existing work that must be reconciled

Branch `worktree-qwen-token-plan` (worktree locked, 9 commits ahead of `main`, 34 behind, last commit 2026-09-17 22:59 UTC) already implements the three-product Alibaba split. It also contains:

- `feat(routing): gate the crossing from a subscription to metered billing`
- `fix(routing): close three gate bypasses and the over-block they hid behind`

The handoff says the opposite: "An available PAYG key is permission to use it", and the backend review adds "These corrections introduce no billing permission or fallback protection gate." Merging this branch as it stands would ship the gate. Decided below: the gate is not carried.

## Decisions (Jack, 2026-09-19)

1. **Reader ownership:** the claudish session `v3-subscription:blocks-everyone` owns the reader and coordinates the provider changes. It rebases the Alibaba work from `worktree-qwen-token-plan` instead of rewriting it, and it has told that session.
2. **No billing gate.** The reader follows the handoff: subscriptions → dynamic subscriptions → native API → aggregators → fallback, and a configured key is permission to use it. The two gate commits on `worktree-qwen-token-plan` are not carried.
3. **claudish adopts the backend's Alibaba identities exactly.** The static values in models-index `ai-docs/alibaba-provider-changes.md` are the single source: one spelling, and no aliases, migration shims, alternate credential names or retired-name diagnostics. The old names are removed, not deprecated.

| Product | Provider | Prefix | Credential | Binding |
|---|---|---|---|---|
| Alibaba Coding Plan (new) | `qwen-coding` | `qcode` | `QWEN_CODING_PLAN_API_KEY` | `qwen/modelstudio-coding-plan` |
| Alibaba Token Plan | `qwen-token-plan` | `qtoken` | `QWEN_TOKEN_PLAN_API_KEY` | `qwen/qwencloud-token-plan` |
| Alibaba PAYG | `qwen-payg` | `qpay` | `DASHSCOPE_API_KEY` | `qwen/dashscope-direct` |

Removed outright: provider `qwen-cloud`, prefixes `qc`, `qp` and `dashscope`, and the credentials `QWEN_CLOUD_PLAN_API_KEY` and `QWEN_API_KEY`.

The new gateway providers take the fixture's names, `together` and `fireworks`, because claudish has no earlier name to keep.

## Requests to the backend

**1. Reader ownership.** Your handoff lists claudish's reader-ownership prompt as pending. It is answered: one claudish session owns the reader, as the handoff asks. The portal identifiers, the binding fixture and `alibaba-provider-changes.md` are already correct, and claudish changes to match them.

**2. Retire "roster" from the wire contract (Jack, 2026-09-19).** The word carries two meanings in the contract today, and neither reader can tell which is meant. claudish already retired it for the same reason (commit `83f9afb`, "roster becomes the dynamic models catalog"). Static values must stay identical on both sides, so the rename happens in the backend first and claudish reads the new names.

- The **dynamic models catalog** is the per-credential model list a provider's discovery endpoint returns. It is never persisted.
- **Membership** is a plan's published member list, part of the cloud catalog. The handoff already uses this word: "Use `subscriptionPlanIds` for memberships".

| Current | Meaning | Requested |
|---|---|---|
| `authenticated_account_roster_required` (inclusion reason, and the Coding Plan's `routeReason`) | dynamic models catalog | **`dynamic_models_catalog_required`** (decided by Jack) |
| `authenticated_variant_roster_required` | dynamic models catalog | `dynamic_variant_catalog_required` |
| `rosterCoverage` | membership | `membershipCoverage` |
| `rosterRequirements` | membership | `membershipRequirements` |
| `rosterId` (in `rosterRequirements[]`) | membership | `membershipSourceId` |
| `RosterEntryV3` | membership | `MembershipEntryV3` |
| `rosters` (`ManualApprovalRequiredErrorV3`) | membership | `memberships` |
| `authoritative_roster_identity_unresolved` | membership | `authoritative_membership_identity_unresolved` |
| `no_exact_callable_roster` | membership | `no_exact_callable_membership` |
| `sourceText` prose: "account-specific Devin model roster", "account-specific Grok subscription roster" | dynamic models catalog | "account-specific Devin dynamic models catalog", and the same for Grok |
| `sourceText` prose: "exact roster not published" | membership | "exact membership not published" |

Only the first row's spelling is Jack's decision. The others are proposed to follow the same two terms; please confirm or adjust them in the change, and claudish will read whatever is published. The reader is being written now, so renaming before it ships means one migration instead of two.

Found by searching the live OpenAPI document and the live plan and probe data of generation `g-20260918181642356-73127622` for every occurrence of the word. The spec itself has no prose using it.

**3. Publish input and output modalities on every model, in every projection.** claudish must decide whether a model can answer a chat turn, and today the data cannot say.

| Field | Full projection | Slim projection |
|---|---|---|
| image input (`vision`), `videoInput`, `videoOutput` | ✓ | ✓ |
| `imageOutput`, `audioOutput`, `audioInput`, `pdfInput` | ✓ | missing |
| text input, text output | not published | not published |

Measured consequences: `gpt-image-2.5-flare` (`imageOutput: true`) is in the slim projection with nothing marking it as an image generator, and seven video-reading models (`gemini-3-pro-image`, `gemini-embedding-2`, …) can be excluded from chat only by their names. A speech-to-text model (`grok-voice-transcribe-2.0`: audio in, text out) cannot be told from a chat model at all, because text is never stated.

Requested shape, as OpenRouter publishes it: `inputModalities` and `outputModalities` arrays drawn from `text`, `image`, `audio`, `video`, `file`, on every model row including slim, alongside the existing booleans. claudish's rule then becomes data: a chat model takes `text` in and gives only `text` out.

## Reproduce

```
bun run ai-docs/reports/VERIFY_models_index_v3_handoff-20260919.ts
```

The script captures the whole generation into a new `ai-docs/sessions/` folder, which is gitignored, and prints PASS or FAIL per claim with its evidence.
