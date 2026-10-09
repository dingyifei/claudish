# Claudish verification against models-index v1.4.14

Generation under test: `g-20260922053223487-99e80e4b`, contract v3.
Verified 2026-09-23 against the live production endpoints, not against a fixture.
Claudish tree: `fix/v3-reader-gaps` @ `196e6f8f`.

Every number below came from a fetch or from running claudish's own code. Where a
claim could not be verified, it says so rather than assuming.

---

## 1. Backend claims — all confirmed

| Claim | Result |
|---|---|
| Active generation `g-20260922053223487-99e80e4b` | confirmed, `contractVersion: 3` |
| 19 plans | confirmed, `queryPlans` returns 19 |
| No paid routes with zero pricing | **confirmed, 0 violations** across 1,750 mapped connections |
| 10 Coding Plan models | confirmed — `alibaba-ai-coding-plan` has 10 members |
| 21 Individual Token Plan entries | confirmed — `alibaba-token-plan-individual` has 21 |
| 32 Team entries | confirmed — `alibaba-token-plan-team-edition` has 32 |
| Probe picks updated | confirmed, all five exact |

Probe picks, expected vs actual `externalModelId`:

```
poe/gateway            gemini-3.8-flash                          OK
qwen/dashscope-direct  qwen3.8-max-0902                          OK
together-ai/gateway    zai-org/GLM-5.3-Flash                     OK
openrouter/gateway     deepseek/deepseek-v4.1-flash              OK
fireworks/gateway      accounts/fireworks/models/glm-5p3-flash   OK
```

Pricing distribution over 1,750 mapped connections: `flat` 875, `unavailable` 708,
absent 106, `free` 33, `tiered` 28. **Zero** `flat`/`tiered` connections sum to 0,
so the previous zero-price defect is genuinely gone. Claudish's defensive rule that
reads a metered zero as unknown (`connection-price.ts`, `isUnmeasuredZero`) now
never fires on this generation; it is kept as a guard, not as a workaround.

**The server enforces the version itself.** Measured: `426 Upgrade Required` for
`version=2`, `version=99`, `application/json`, and for a missing `Accept` header.
A claudish path that forgets the header fails hard rather than silently reading
older data. That is stronger than the contract asks for and worth keeping.

---

## 2. Contract items claudish already satisfies

| Item | Evidence |
|---|---|
| v3 `Accept` on every catalog request | 3 call sites, all from `CATALOG_V3_ACCEPT` (`catalog-v3.ts:1`): `catalog-client.ts:290`, `probe-catalog.ts:100`, `model-loader.ts:297` |
| Reject non-v3 | `contractVersion` checked at `catalog-client.ts:312-325` and again in `parseCatalogV3Envelope`; a mismatch aborts the refresh and writes no cache — never a silent fallback |
| Pin model reads to one generation | `catalog-client.ts:346-364`; a later page with a different `generationId` returns `generation_mismatch` and discards the whole refresh |
| Pin plan reads | `catalog-client.ts:448-455`, pinned to the model generation |
| Pin default/recommended reads | `model-loader.ts:775-790`, three separate generation checks, throws on mismatch |
| Pin paginated provider reads | `model-loader.ts:304-306`, throws mid-pagination |
| `subscriptionPlanIds` for membership | `adapters/model-catalog.ts:337-340`, the only membership source in the decision path |
| Select by the `(routeId, routeProfileId)` PAIR | `catalog-route-bindings.ts:106-117`, used by every selection site |
| Send the connection's exact `externalModelId` | `catalog-client.ts:139-150`; `route-candidates.ts:209-214` drops a candidate whose id does not match the row it came from |
| Three Alibaba products separate | all 12 cells correct — names, prefixes `qcode`/`qtoken`/`qpay`, credentials, routes. Three distinct hosts. No key aliasing. `legacyPrefixes: []` on all three; no `qwen-cloud`, `qc@` or `qp@` anywhere in source |
| No extra PAYG gate | exactly two filters admit a candidate (credential presence, then availability). No consent, adoption window or opt-in exists. The only metered-specific behaviour is an informational stderr line printed *after* the decision |
| Five dynamic transport bindings | all present verbatim (`catalog-route-bindings.ts:28,30,32,34,35`) |
| Routing order | `TIER_RANK` = subscription 0, dynamic-subscription 1, native 2, gateway 3, fallback 4 — exactly the contract's order. The backend's "aggregators" tier is claudish's `gateway` |
| Dynamic providers use the authenticated client | `model-availability.ts:78-99` — discovery is asked first and is the *only* source allowed to deny; the catalog may confirm but never refuse |

Pagination: models 1000/page capped at 40 pages, plans 100/page capped at 40,
provider-paged 200/page capped at 40. A repeated cursor or a cursor still present
at the cap aborts and keeps no partial data.

---

## 3. Gaps — in priority order

### 3.1 LIVE BUG: the GLM dialect ignores `reasoning.mandatory` (highest priority)

**Not a contract gap — a defect the contract's data already fixes.**

The catalog publishes, at model level, for both `glm-5.3` and `glm-5.3-flash`:

```json
{ "supported": true, "mandatory": true, "control": "effort",
  "efforts": ["max", "high", "low"], "defaultEffort": "max" }
```

`mandatory: true` means reasoning cannot be turned off. `BaseAPIFormat` honours it
(`base-api-format.ts:598-604`). `GLMModelDialect` **overrides** that method
(`glm-model-dialect.ts:53`) and does not check it. Measured by running the dialect:

```
glm-5.3        effort=minimal  mandatory=true  thinking={"type":"disabled"}   <-- 400 code 1210
glm-5.3        effort=none     mandatory=true  thinking={"type":"disabled"}   <-- 400 code 1210
glm-5.3        effort=low      mandatory=true  thinking={"type":"enabled"}  reasoning_effort=low
glm-5.3-flash  effort=minimal  mandatory=true  thinking={"type":"disabled"}   <-- 400 code 1210
glm-4.7        effort=minimal  mandatory=false thinking={"type":"disabled"}   (correct)
```

Z.AI answers `{"thinking":{"type":"disabled"}}` with `400 code 1210 "This model
always engages in thinking and cannot be disabled"` — measured 2026-09-21.

Scope: the OpenAI-compatible wire, so `glm@` and `glm-coding@`/`gc@`. `z-ai@` is on
the Anthropic wire and already correct. v10.0.1 fixed the *probe's* effort choice
only; the main request path was never fixed. The fix needs no new contract: the
fact is already published and already parsed (`all-models-cache.ts:11`).

### 3.2 `aggregators[].reasoning.request` is not read at all

Claudish reads model-level `reasoning` but nothing reads the per-connection request
profile. Zero of this section is implemented.

**Scope of what it would buy today, measured over all 1,750 mapped connections:**

```
(absent)     1741
unknown         8
supported       1     <- glm-5.3 on z-ai/direct-api, the only one
```

So a full JSON-Pointer implementation changes behaviour for exactly one connection
on this generation. That is not an argument against building it — it is the right
shape and it replaces hand-maintained vendor dialects — but the sequencing should
be honest: 3.1 fixes a live 400 today, this fixes a class going forward.

**Where it would land:** the per-vendor dialects (`glm-model-dialect.ts`,
`qwen-model-dialect.ts`, `grok-model-dialect.ts`, `deepseek-model-dialect.ts`),
which today hardcode exactly what `enable` and `effort.values` publish.

### 3.3 Strict compliance would regress six measured cases — needs a backend decision

The contract says: for `status: "unknown"` or an absent profile, do not infer
request parameters. Claudish carries `MINIMAL_EFFORT_UNSUPPORTED` (`probe-live.ts:153`),
seven providers where sending effort `minimal` produced a measured 400:

| provider | route | published profile? |
|---|---|---|
| `glm`, `z-ai` | `z-ai/direct-api` | yes — `supported`, for `glm-5.3` only |
| `glm-coding` | `z-ai/glm-coding-subscription` | **absent** |
| `native-anthropic` | `anthropic/claude-code-subscription` | absent |
| `anthropic` | `anthropic/direct-api` | absent |
| `google` | `google/direct-api` | absent |
| `qwen-payg` | `qwen/dashscope-direct` | absent |

Deleting the list to comply strictly would re-break six of seven. Note the list is a
*clamp* — "do not send this value, it 400s" — rather than an inference of request
parameters, so it may not be what the contract means to forbid. **Question for the
backend:** does "do not infer" forbid a measured negative constraint, or only
forbid synthesising request parameters? The handoff notes a Flash profile is not
published yet because the effort mapping is unestablished; `glm-coding` is exactly
that case.

### 3.4 Probe reads are not pinned to the generation

`probe-catalog.ts:94-103` fetches `/probeModels` with no `generationId` parameter
and never compares the returned generation against the models cache. Consumers
(`getProbeModel`, `getProbeUnavailability`, `routeOwnership`) read it without
checking. It is one request, so nothing mixes *within* the path — but probe data can
be from a different generation than the model and plan data it is used beside. Four
of the five read paths are pinned; this is the fifth.

### 3.5 Modality filtering still infers from names when the catalog is silent

The contract says treat missing modalities as unknown and do not infer from names.
Measured on this generation: **359 of 1,131** models publish no `inputModalities`
and **308** publish no `outputModalities` — about a third.

`classifyChatCapability` (`transport/probe-discovery.ts:217-235`) checks catalog
modalities first and only falls back to name patterns when there is no evidence
(lines 229-232). That fallback exists because this function also classifies names
returned by a *provider's own* discovery endpoint, which may not be in the catalog
at all; removing it lets embedding and TTS models be offered as chat models, a
defect this project has already shipped once.

**Question for the backend:** does the rule apply to names the catalog has never
published, or only to catalog models?

### 3.6 Six passthrough fallbacks derive a wire id from the requested name

Contract item: "Do not derive provider model names from the canonical model ID or
aliases." Six sites do, when no connection publishes an id:
`routing-rules.ts:204-212`, `catalog-client.ts:159-162` and `:199-206`,
`route-candidates.ts:295-300`, `model-selector.ts:1110-1114`,
`native-handler-advisor.ts:1625-1628`.

One of these is endorsed by the contract itself: `route-candidates.ts:295-300` is the
namespace-claim path for dynamic subscriptions, which have no catalog connection to
read an id from and whose transport resolves the account's own id. Aliases are never
used as a wire id anywhere — alias hits always re-enter `externalIdFor`. The
remaining five need a per-site decision.

---

## 4. Two corrections

**MiniMax tier.** Claudish gives `minimax-coding` `tier: "subscription"`, not
`dynamic-subscription` like the other four. The probe map lists
`minimax/coding-plan-subscription` under `providers` with a concrete
`modelId`/`externalModelId`, not under `unavailableRoutes` with
`client_model_selection_required` — so the backend enumerates it and claudish's tier
looks right. The contract's own words are "MiniMax is hybrid". Flagging only to
confirm that reading is intended.

**A stale-fixture finding, withdrawn.** An intermediate audit reported that
`qwen-coding` was unreachable by bare name because its route published zero
connections. That was read from a 2026-09-18 session fixture. On the live generation
the route has **10** mapped connections, and `route()` reaches `qwen-coding` first
for every one:

```
qwen3.7-plus      qwen-coding -> qwen-token-plan -> opencode-zen-go -> qwen-payg -> openrouter -> opencode-zen
glm-5             qwen-coding -> qwen-token-plan -> glm -> z-ai -> openrouter -> opencode-zen -> poe
qwen3-coder-next  qwen-coding -> qwen-payg -> openrouter
```

Recorded because the failure mode generalises: auditing against a session fixture
instead of the live generation produces confident, wrong findings.

---

## 5. Release acceptance — status

| Required | Status |
|---|---|
| strict-v3 reader and pagination tests | exist; need re-run against this generation |
| exact route and `externalModelId` translation tests | exist (`route-candidates.test.ts`) |
| all three Alibaba credentials and prefixes | verified in source; test coverage to confirm |
| dynamic provider selection tests | exist |
| connection-specific reasoning parameter tests | **none — feature not implemented (3.2)** |
| dev-session readback against the active generation | **this document** |
| authenticated calls where access permits | partial: Token Plan and OpenCode Zen Go live-verified; Alibaba PAYG denied account-side (below) |
| merged source and published version | **not done** — 3.1 is a live bug and should ship first |

**Alibaba PAYG, on the "separate facts" point.** The backend is right and claudish
now agrees. Measured against `dashscope-intl` 2026-09-22: the model list succeeds,
inference is refused for every model, including `qwen-turbo`:

```
qwen-turbo   non-stream  403 AccessDenied      "Model access denied."
qwen-turbo   stream      400 InvalidParameter  "Model access denied."
qwen3.8-max  stream      403 AccessDenied      "Model access denied."
```

All 137 models mapped to `qwen/dashscope-direct` are refused, so this is account
model access, not a missing model or a wrong route. Claudish reports it as an
account-level denial and now shows the provider's own sentence rather than an
inference about it (commit `196e6f8f`). Note also that Alibaba returns a *different
status* for one fact depending on `stream`.

---

## 6. Addendum, 2026-09-23: modality filtering went strict, and what that asks of the backend

Section 3.5 asked whether "do not infer from names" covers names the catalog never published.
The answer chosen was **yes, everywhere**, and claudish now implements it:

- `NON_CHAT_PATTERNS` (17 regexes) and `VIDEO_OUTPUT_NAME_PATTERNS` (4) are **deleted**. No model
  is classified by how its id is spelled.
- `isChatCapable` requires a positive `"chat"` verdict. `"unknown"` is no longer offered.
- Provider-published capability is read and outranks the catalog, because it describes the
  deployment rather than the canonical model: Ollama's per-model `capabilities`
  (`["completion","tools","vision"]` against `["embedding"]`) and LM Studio's `type`.
- An explicit `provider@model` spec bypasses all of it. The user named the model; claudish sends
  it. Verified: `routeExplicit` has no capability gate.

**`supportsVision` was removed from claudish's chat inference.** It is an INPUT capability, and
reading it as evidence of text output was the same class of guess as the name regexes. Measured:
19 rows had no published output modality and `supportsVision` as their only chat signal, and 17
were image, video, audio or moderation models. `sora-2` is the clean case — its sibling
`sora-2-pro` publishes `outputModalities: ["video"]` and was excluded correctly, while `sora-2`
has the field absent, so the vision flag was the only thing speaking for it.

### Models published without `outputModalities`

On generation `g-20260923015912067-d8c0c200`, 64 of 1,137 catalog entries carry no
`outputModalities` and are therefore unavailable by bare name. (The first count, 87 on
`g-20260922053223487-99e80e4b`, fell to 64 when the backend's next generation described 23
more.) `unavailableForMissingCapability` lists them on demand; triage belongs to the backend.

An earlier revision of this section called about 25 of them genuine chat models to restore.
That was wrong and is withdrawn. Most of those rows are `deprecated` in the catalog
(`gpt-4-0613`, `gpt-3.5-turbo-0125`, `gemini-2.0-flash-001`), and several are pretrained base
checkpoints whose instruction-tuned sibling is published and classifies as chat
(`gemma-3-27b-pt` → `gemma-3-27b-it`, `qwen3-8b-base` → `qwen3-8b`,
`mixtral-8x7b-v0.1` → `mixtral-8x7b-instruct-v0.1`). Nothing a user chats with was lost.

### What claudish reports instead of guessing

`unavailableForMissingCapability(names)` returns `{catalogSilent, providerSilent}` and the
discovery failure messages now name the silent party rather than saying "no chat-capable model":

    no capability data for 3 of 12 listed models —
      this endpoint publishes no capability field
      (text-embedding-3-small, tts-1, whisper-1)

`catalogSilent` is the list above — models-index work. `providerSilent` is an endpoint that
publishes no capability field at all, which no backend work reaches: a plain OpenAI-compatible
`/v1/models` returns `{id, object, created, owned_by}`. LiteLLM, vLLM, MLX and custom endpoints
are in that bucket, and their models are reachable only by explicit `provider@model` until either
the catalog describes them or the endpoint starts publishing. LiteLLM's `/model/info` does
publish a `mode` field; reading it is not yet implemented and would shrink that bucket.

### The rule claudish applies, and three rows it trusts that look wrong

Decided 2026-09-23 and shipped in claudish v10.1.1: a chat model has `"text"` among its
`inputModalities` AND among its `outputModalities`; other modalities on either side never exclude
it. An absent, `null` or `[]` input list is read as unknown and denies nothing (your contract).
So your published modalities are now the whole decision for every catalog row — there is no name
rule behind them any more — and a wrong row is shown or hidden exactly as published.

Measured on generation `g-20260923031256925-3d26cd04`, three generator models publish
`in: ["text"]`, `out: ["text"]` and are therefore offered as chat models:

| modelId | published | looks like |
|---|---|---|
| `flux-dev-finetuner` | `in: [text]`, `out: [text]` | an image-model fine-tuning job |
| `flux-fill` | `in: [text]`, `out: [text]` | image inpainting (`out` should include `image`) |
| `seedance-2.5-el` | `in: [text]`, `out: [text]` | a Seedance video variant (`videoOutput` unset) |

Please check these three. claudish logs them once per process (`[Models] … the catalog publishes
as chat, from a generator family`) rather than filtering them itself.
