# Reply to models-index (2026-09-21)

Ready to send as is. Validation behind every claim: `BACKEND_TASKS_models_index-20260920.md`.

---

**Re: models-index — delivery validated, two follow-ups, and the two answers you asked for**

We read generation `g-20260920154425586-418ad3dd` live and then through our own reader. Modalities,
the naming cutover, the route prices and the Vertex reason are all delivered and correct on our side.

What we checked:

- **Modalities.** 702 of the first 1,000 slim rows carry `inputModalities`/`outputModalities`, and
  211 of those have a non-text output (for example `gpt-image-2.5-flare: ["image"]`). Unknown arrives
  as an absent field: 0 nulls, 0 empty lists, 298 absent.
- **Naming.** No "roster" token remains in `queryModels`, `queryPlans` or `probeModels`; the plans
  carry `membershipRequirements`, `membershipId` and `membershipCoverage`.
- **Prices.** Every metered profile is fully priced: `qwen/dashscope-direct` 136/136,
  `openai/direct-api` 130/130, `google/direct-api` 46/46, `mistralai/direct-api` 18/18,
  `fireworks/gateway` 25/25, `poe/gateway` 281/281, `together-ai/gateway` 236/236,
  `openrouter/gateway` 468/468, `ollama/cloud` 24/24, `opencode/zen` 74/74. Subscription profiles stay
  unpriced, which is right. The discriminator reports flat 1,004, unavailable 469, tiered 28, and on
  all 28 tiered connections the top-level `input`/`output` equal the first tier, which is what we sort
  by.
- **Vertex.** `vertex/google-cloud` now reports `client_model_selection_required`.
- **Our reader.** A forced refresh reads 1,119 entries across pages and 19 plans; Alibaba memberships
  are 10/20/31 and kimi-code is 4; `kimi-k3`, `qwen3.8-max` and `glm-5.3` route exactly as before.

Thank you, this was a lot in one pass.

## Follow-up 1: Poe has connections but no probe pick

281 models now map to `poe/gateway`, and `probeModels` still reports `no_verified_probe_model` for it.
The verified pick is the remaining half of that item.

## Follow-up 2: please rename the pricing discriminator `shape` to `type`

Our first draft asked for `shape` and you built exactly that, so this is our inconsistency, not yours.
Since then `type` is the project's word for a discriminator and it is in claudish's thesaurus, so both
sides say one thing. The values are unchanged: `flat`, `tiered`, `free`, `unavailable`. No alias,
please: name the cutover generation and claudish switches on it, the same way as the membership
rename.

## Answers to your two design questions, for the record

**Unknown modalities.** What you shipped is right. `null`, an absent field and an empty list all read
as unknown to us, because no model produces nothing, so an empty output list cannot mean "no outputs".
Please keep not inferring from names or probes: we would rather show "unknown" and keep the model
available than act on a guess.

**Tiered prices.** The shape you shipped works. We order by the first tier and label the choice
"tiered"; we never average tiers and never guess a tier from request size. `unavailable` sorts after
priced connections inside the same tier.

## Note 1: a fault of ours that polluted your Alibaba evidence

Our probe sends `output_config.effort`. On `dashscope-intl` that field is validated server-side
against an enum with no `minimal`, so the host answered `400 InvalidParameter` **before** evaluating
entitlement. Any Alibaba PAYG result you collected through claudish before today showed that 400 and
hid the real answer. Fixed on our side; the honest answer on that account is a 403.

## Note 2: Alibaba PAYG is deferred on our side, please do not reconcile ids

We are leaving PAYG until after our v3 release. The denial does not depend on the model id. Measured
directly with the key, outside claudish, on `dashscope-intl`: three request shapes (Anthropic
`/apps/anthropic/v1/messages`, OpenAI `/compatible-mode/v1/chat/completions`, DashScope native
`/api/v1/services/aigc/text-generation/generation`) times three models (`qwen3.8-max-0902`,
`qwen-plus`, `qwen-max`) gave nine of nine `403 Model.AccessDenied`, while the same key lists 169
models. The China host rejects the key outright.

## Probe picks: nothing needed

Your reasoning holds: picks come from models common to every account, and client-selected routes are
marked. We treat a pick as the first candidate rather than an entitlement, so a per-account denial
costs one attempt and no more.

## What we expect next from you

1. The Poe verified probe pick.
2. The `shape` to `type` rename, with the cutover generation named; it can ride on any cutover.

Nothing we are building depends on either, so both sides can work in parallel.
