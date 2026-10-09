# Tasks for models-index, from claudish (2026-09-20)

> **Revision 2, after the backend's re-review.** The live generation is now
> `g-20260920004438652-e636f445` (models-index v1.2.104); the generation named further down was
> current when the tasks were written. Status of each task, and the two design questions the backend
> asked, are answered in "Answers and corrections" immediately below. T4 is **done**; T1, T2, T3 and
> T6 are confirmed by both sides; T5 is settled as "one route, classified metered by claudish".

## Delivery validated (claudish, 2026-09-21, generation `g-20260920154425586-418ad3dd`)

Read live from the deployed service, and then through claudish's own reader.

| Task | Result |
|---|---|
| T1 modalities | **Delivered.** 702 of the first 1,000 slim rows carry `inputModalities`/`outputModalities`; 211 of those have a non-text output (`gpt-image-2.5-flare: image`). Unknown is encoded as an absent field: 0 nulls, 0 empty lists, 298 absent. That matches the contract. |
| T2 naming | **Delivered.** No "roster" token remains in `queryModels`, `queryPlans` or `probeModels`; the plans carry `membershipRequirements`, `membershipId` and `membershipCoverage`. claudish reads none of these, so nothing broke. |
| T3 prices | **Delivered.** Every metered profile is now fully priced: `qwen/dashscope-direct` 136/136, `openai/direct-api` 130/130, `google/direct-api` 46/46, `mistralai/direct-api` 18/18, `fireworks/gateway` 25/25, `poe/gateway` 281/281, `together-ai/gateway` 236/236, `openrouter/gateway` 468/468, `ollama/cloud` 24/24, `opencode/zen` 74/74. Subscription profiles stay unpriced, which is right. The discriminator is published as `shape`: flat 1,004, unavailable 469, tiered 28. On all 28 tiered connections the top-level `input`/`output` equal the first tier, so claudish can order by the top-level number. |
| T6 Poe | **Half delivered.** 281 mapped connections, and no verified probe pick: `poe/gateway` still reports `no_verified_probe_model`. |
| T6 Vertex | **Delivered.** `vertex/google-cloud` now reports `client_model_selection_required`. |
| claudish reader | **Unaffected.** A forced refresh reads 1,119 entries across pages and 19 plans; Alibaba memberships are 10/20/31 and kimi-code is 4; `kimi-k3`, `qwen3.8-max` and `glm-5.3` route exactly as before. |

Two follow-ups: the Poe probe pick, and **renaming the pricing discriminator `shape` to `type`**. The
first draft of this document asked for `shape`, and you built exactly that; since then `type` is the
project's word for a discriminator and it is now in claudish's thesaurus, so both sides say one thing.
Please rename it at whatever cutover suits you, with no alias, and name the generation; claudish
switches on that generation. The values are unchanged: `flat`, `tiered`, `free`, `unavailable`.

## Answers and corrections (claudish, revision 2)

**Correction accepted.** The four values we listed (`authenticated_account_roster_required`,
`authenticated_variant_roster_required`, `no_exact_callable_roster`,
`authoritative_roster_identity_unresolved`) are inclusion-resolution reasons, not `routeReason`
values. The rename request is unchanged; only our label for them was wrong.

**Design question 1: how to publish an unknown modality.** Publish what you verified, and leave the
rest unknown in whichever way suits the schema: `null`, the field absent, or an empty list. claudish
treats all three as unknown, because **no model produces nothing**, so an empty output list cannot
mean "this model has no outputs" and can only mean "not established". Please do not infer a list from
a name or a probe, exactly as you propose: claudish can say "unknown" and keep the model available,
while a wrong `["text"]` would silently route an image model into a chat.

**Design question 2: how to represent tiered prices.** claudish needs one comparable number per
connection, because Jack's routing rule of 2026-09-20 orders candidates inside a tier by the model's
own vendor first, then by price. A shape that keeps the truth and still sorts:

```jsonc
"pricing": {
  "type": "flat" | "tiered" | "free" | "unavailable",
  "input": 0.3, "output": 1.2, "cachedRead": 0.006,   // flat: as today
  "tiers": [                                           // tiered: ascending, by input size
    { "maxInputTokens": 32000,  "input": 0.3, "output": 1.2 },
    { "maxInputTokens": 128000, "input": 0.6, "output": 2.4 }
  ]
}
```

`type` is a discriminator: it says how to read the rest of the object. Without it, a reader cannot
tell "no price published" from "the price is zero", nor whether the top-level numbers are the whole
price or only the first tier.

- `flat`: as today.
- `tiered`: claudish orders by the FIRST tier and labels the choice "tiered" where it shows a price.
  It will not average tiers and will not guess a tier from the request size.
- `free`: a genuinely free model. `flat` with `input: 0, output: 0` says the same thing; pick
  whichever is cleaner in your schema, as long as it is distinguishable from "unknown".
- `unavailable`: claudish treats the connection as unpriced and places it after priced ones inside
  the same tier, which is what we already agreed for missing prices.

Alibaba's 28 tiered models are the case `tiered` exists for; the 20 PAYG ids with no representable
price should be `"type": "unavailable"` rather than omitted, so we can tell "no price yet" from "not
published".

**Probe picks: no change requested.** You publish one pick per static route, chosen from the models
common to every account and recent, and client-selected routes are already marked. That is sound, and
claudish treats a pick as the first candidate rather than an entitlement, so a per-account denial
costs one attempt. Nothing for you to do here.

**Alibaba PAYG: deferred on our side, no action needed from you.** We are leaving it until after the
v3 release. Do not spend time reconciling the remaining PAYG ids: the denial does not depend on the
id. Measured directly with the key, outside claudish, on `dashscope-intl`: three request shapes
(Anthropic `/apps/anthropic/v1/messages`, OpenAI `/compatible-mode/v1/chat/completions`, DashScope
native `/api/v1/services/aigc/text-generation/generation`) times three models (`qwen3.8-max-0902`,
`qwen-plus`, `qwen-max`) are nine of nine `403 Model.AccessDenied`, while the same key lists 169
models; the China host rejects the key outright.

**Alibaba PAYG, earlier evidence.** We agree the credential is good: it reads the official model API
here too (`GET /compatible-mode/v1/models` on `dashscope-intl`, HTTP 200, 169 models). The failure is
on chat calls only, and it is not about the model id:

- your new pick `qwen3.8-max-0902`: `403 Model.AccessDenied` through claudish, after we fixed our own
  fault on that path (we were sending `output_config.effort: "minimal"`, which that host rejects by
  enum with `400 InvalidParameter`; the Token Plan host accepts it);
- ids taken from the account's own list (`qwen-plus-character`, `qwen3.8-flash`, `qwen3.8-max`,
  `qwen3.7-plus`): the same `403 Model.AccessDenied`.

So no PAYG id we tried is callable by this account, while the same key lists models. We read that as
account model access, not catalog data, and claudish ships `scripts/validate-dashscope-key.ts` so a
user can separate the two themselves.

**Poe.** Agreed that discovery belongs in the backend, and we will consume `poe/gateway` identities
and a verified pick once they are mapped. claudish keeps its own account-list discovery as the
fallback for a provider with no published pick, which is what makes Poe testable today.

**Vertex.** Agreed. The rule that grants `client_model_selection_required` only to subscription
profiles is the reason Vertex reads `no_verified_probe_model`; claudish owns discovery there either
way, so this is cosmetic for us and worth fixing only so the reason states the decision.


Every item below was measured against the **live** service, not a cache. Unless stated otherwise the
generation is `g-20260919132927305-5a035947` (893 slim rows), read with
`Accept: application/vnd.models-index.catalog+json;version=3`.

Reproduce any line with:

```
BASE=https://us-central1-claudish-6da10.cloudfunctions.net
ACCEPT='Accept: application/vnd.models-index.catalog+json;version=3'
curl -sH "$ACCEPT" "$BASE/queryModels?status=all&catalog=slim&includeRouteVariants=true&limit=1000"
curl -sH "$ACCEPT" "$BASE/queryModels?status=all&catalog=full&limit=5"
curl -sH "$ACCEPT" "$BASE/queryPlans?limit=100"
curl -sH "$ACCEPT" "$BASE/probeModels"
```

Context: claudish now reads contract 3, sends exact wire ids, and decides chat capability from
`videoOutput`. The tasks below are the gaps that remain on the publishing side. None of them is
urgent for correctness of what claudish already ships; each removes a guess claudish would otherwise
have to make, and claudish will not work around any of them locally.

---

## T1. Publish input and output modalities on every projection

**What we see.** The full projection's `capabilities` object carries, in this generation:
`audioInput, audioOutput, batchApi, citations, codeExecution, fineTuning, imageOutput, jsonMode,
pdfInput, promptCaching, streaming, structuredOutput, tools, videoInput, videoOutput, vision`.
No row carries any key matching `/modal/i`, on any projection. The slim projection carries only
`supportsVision`, `videoInput` and `videoOutput`.

**Why it matters.** claudish must decide whether a model is a chat model, that is text in and text
out. Today it infers that from `videoOutput` plus a name-shaped rule for rows the catalog does not
cover. Both are inferences about something the catalog knows.

**Asked for.** `inputModalities` and `outputModalities` per model, as explicit lists (for example
`["text","image"]` and `["text"]`), on the slim and full projections alike, for every model
including route variants.

**Acceptance.** A slim row for a text model reports `outputModalities: ["text"]`; an image generator
reports `["image"]`; a model that reads video but answers in text reports video in the input list and
only text in the output list.

---

## T2. Rename the retired "roster" vocabulary on the wire

**What we see.** `queryPlans` publishes `rosterRequirements[]` (with `rosterId`, `authority`,
`requiredForActivation`, `maxAgeHours`) and `rosterCoverage` (`status`, `observedAt`, `expiresAt`),
and these `routeReason` values: `authenticated_account_roster_required`,
`authenticated_variant_roster_required`, `no_exact_callable_roster`,
`authoritative_roster_identity_unresolved`. The slim projection carries the word inside collector
ids, for example `"sourceCollectorId":"checked-roster:anthropic-claude-code-checked"`. `probeModels`
is already clean.

**Why it matters.** Both projects agreed one name per concept: a **dynamic models catalog** is the
list one credential can see, and a **membership** is what a plan publishes. "Roster" was used for
both, which is how the two got confused in the first place. claudish has removed the word from its
own source (0 occurrences) and quotes these wire names verbatim until they change.

**Asked for.**
- `rosterCoverage` → `membershipCoverage`; `rosterRequirements` → `membershipRequirements`;
  `rosterId` → `membershipId` (or `sourceId` where it names the collector, not a membership).
- `authenticated_account_roster_required` → `dynamic_models_catalog_required` (agreed with Jack).
- `authenticated_variant_roster_required`, `no_exact_callable_roster` and
  `authoritative_roster_identity_unresolved` → the same vocabulary; propose names and we will follow.
- Collector ids: rename at your convenience; they are opaque to claudish.

**Acceptance.** `curl … | grep -i roster` returns nothing for `queryModels`, `queryPlans` and
`probeModels`. Please tell us the generation in which the rename lands, so claudish can switch on the
same day: claudish keeps no alias for a renamed value.

---

## T3. Publish pricing for metered route profiles

**What we see.** 23 of 24 route profiles have mapped connections without `pricing`. Whole metered
profiles have none at all:

| Route profile | Priced / mapped |
|---|---|
| `qwen/dashscope-direct` | 0 / 141 |
| `openai/direct-api` | 0 / 130 |
| `google/direct-api` | 0 / 46 |
| `fireworks/gateway` | 0 / 26 |
| `mistralai/direct-api` | 0 / 20 |
| `opencode/zen` | 61 / 78 |
| `openrouter/gateway` | 401 / 526 |
| `together-ai/gateway` | 243 / 244 |
| `ollama/cloud` | 20 / 24 |

Where pricing exists it is `{input, output, cachedRead}`, which is the shape claudish wants.

**Why it matters.** Jack decided claudish's routing order on 2026-09-20: inside one tier, the model's
own vendor first, then **cheapest by the catalog's price**, then the rest, with no local table and no
local state. Without a price for a metered connection, claudish cannot order it and must fall back to
"the rest", which puts an expensive gateway ahead of a cheap one by accident.

**Asked for.** `pricing` on every **metered** mapped connection (`direct-api` and `gateway`
profiles). Subscription profiles need none, and should carry none rather than a zero.

**Acceptance.** Each metered profile above reports priced == mapped, or names the models it cannot
price and why.

---

## T4. Probe picks must be models an ordinary account can call

**What we see.** Two of the 24 picks fail that test.

- `mistralai/direct-api` → `labs-leanstral-1-5`. Measured 2026-09-19 with a working Mistral key:
  `403 "Model labs-leanstral-1-5 is a Labs model. To use Labs models, an admin must enable them in
  your organization settings at https://admin.mistral.ai/plateforme/privacy."` The same account's
  `/v1/models` returns 53 models, of which 51 are not Labs.
- `qwen/dashscope-direct` → `qwen3.8-omni-flash`, an omni model, as the pick for a text chat probe.

**Why it matters.** The pick is the first model Test All tries. A pick no ordinary account may call
reads to the user as "this provider is broken". claudish now walks to the next candidate where the
provider publishes a model list, but the first impression is still a failure, and a provider without
a list has no second candidate.

**Asked for.** Pick a generally available text chat model: exclude Labs, preview and allow-listed
models, and prefer a plain text model over an omni, audio, image or realtime variant.

**Acceptance.** Every pick in `probeModels` is a model whose access needs nothing beyond a valid key
for that product, and whose output modality is text (see T1).

---

## T5. Split `ollama/cloud` into a subscription profile and a metered profile

**What we see.** One profile, `ollama/cloud`. The plan `ollama-cloud` binds to it
(`routeStatus: supported`), and 20 of its 24 mapped connections also carry per-token `pricing`.
OpenCode is already split the way we mean: `opencode/go-subscription` and `opencode/zen`.

**Why it matters.** Jack's rule of 2026-09-20: metered and subscription are always separate products
in claudish, even when one key serves both, so that spending money is explicit and each lands in its
own tier of the routing chain. With one profile, claudish cannot tell which one a request would bill.

**Asked for.** Two profiles under `ollama`, following the OpenCode precedent: one for the Cloud
subscription that the `ollama-cloud` plan binds to, and one metered. Tell us the profile ids; claudish
adds the second provider only once they exist, and will not invent the identity.

**Acceptance.** `queryPlans` binds `ollama-cloud` to the subscription profile, and the metered
profile carries the pricing.

---

## T6. Poe and Vertex: `no_verified_probe_model`

**What we see.** `poe/gateway` and `vertex/google-cloud` are the only two unavailable picks that are
not `client_model_selection_required`. Poe answers normally with a key: `/v1/models` returns 341
models and a chat request returns 200 (measured 2026-09-19).

**Why it matters.** Low. claudish now discovers a Poe model from the account's own list and probes it
(`gpt-5.4`, live). Vertex is moving to Google's Application Default Credentials on our side.

**Asked for.** Either verify a pick for these two, or mark them `client_model_selection_required`,
which is what they behave like. Today's reason says the backend intends to have a pick and does not,
which reads as a temporary gap rather than a decision.

**Acceptance.** Each of the two carries a verified pick, or the reason states that the client selects.

---

## Not a backend task, recorded to close the question

**Alibaba PAYG "Model access denied" is not a catalog fault.** The catalog's `qwen/dashscope-direct`
wire ids match the account's own list, spelled the same. The account's `GET
/compatible-mode/v1/models` returns 200 with 169 models, and a chat request for an id taken from that
list (`qwen-plus-character`) answers `403 Model.AccessDenied`, exactly as the catalog's ids do. The
account's model permissions are the cause. claudish ships a script for this,
`scripts/validate-dashscope-key.ts`, which separates "key rejected" from "access denied".
