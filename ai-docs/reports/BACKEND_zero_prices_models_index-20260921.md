# To models-index: the rename and the Poe pick landed, and one new price defect

Ready to send. Everything below was read from the live service today, generation
`g-20260921062451697-f490edba`.

---

**Re: `pricing.type` and the Poe pick are live — thank you; one data defect to fix**

Both items we were waiting on are delivered and correct on our side. We read them live and then
through our own reader.

- **The discriminator is `type`.** The pricing object's keys are now
  `batchDiscountPct, cachedRead, cachedWrite, input, output, tiers, type`. The old spelling is
  gone entirely, which is exactly what we asked for — no alias to carry on either side. Values:
  `flat` 975, `unavailable` 467, `free` 30, `tiered` 28. claudish reads `type` and only `type`.
- **The Poe pick is published.** `probeModels` now returns `poe/gateway` →
  `gemini-3.8-flash`, where it previously reported `no_verified_probe_model`. It survives our
  route-to-provider mapping and reaches our probe path unchanged. 25 picks, 5 unavailable
  routes, and all five of those are `client_model_selection_required`
  (`antigravity`, `grok-subscription`, `vertex`, `sakana-subscription`, `devin`) — the four
  dynamic subscriptions plus Vertex, which is the agreed design rather than a gap.
- **Our reader.** A forced refresh reads 1,123 entries across 2 pages on that generation. Of
  1,734 mapped connections, 923 now carry a price we can order by and 811 do not.

## The defect: 167 metered connections quote a price of zero

167 connections publish `type: "flat"` with `input: 0` and `output: 0`. By route:

| Route | Zero-priced connections |
|---|---|
| `together-ai/gateway` | 163 |
| `openrouter/gateway` | 3 |
| `opencode/zen` | 1 |

Examples on `together-ai/gateway`: `glm-5.3-fp8`, `glm-5.3-fp8-lora`, `minimax-h3`, `flux-3`,
`seedance-2.5`, `flash-image-3.1-lite`. Together AI charges for all of those, so zero is not
their price — it is a price nobody measured, published as if it were measured.

Why it matters more than an unpriced row: **zero is the strongest possible price.** A consumer
ordering connections by cost puts a zero first, so the effect of a missing measurement is to
PROMOTE that connection above every genuinely cheap one. An `unavailable` row merely sorts last.
This is the one direction in which a data gap costs a user money rather than a better option.

What we ask: publish `type: "unavailable"` where the rate is unknown, and reserve zero for a rate
that is genuinely zero. The contract already separates those two cases cleanly, and 30
connections use `type: "free"` correctly today.

**What claudish does until then.** We treat a `flat` or `tiered` price summing to exactly zero as
unknown, so those 167 connections sort last instead of first. The rule is asymmetric on purpose:
a zero on ONE side is kept, because free input with paid output is a real tariff. Only zero on
both sides is rejected. We would rather delete that rule than keep it — it is a guess about your
data, which is exactly what both sides agreed to avoid — so it goes as soon as the rows say
`unavailable`.

## A short list of first-party models that may be missing their vendor's own route

Low priority, and we checked carefully before sending it, because our first pass at this was
wrong. Counting raw totals suggested your own-API coverage was badly incomplete (deepseek 2 of 34,
qwen 136 of 240). It is not. Vendors expose only current models on their own APIs, and once retired
generations, open-weight releases, gateway quantizations (`-fp8`, `-fp4`, `-lora`), provider-suffixed
variants (`-di`, `-n`, `-el`, `-fw`) and route variants (`kimi-k3-256k`) are excluded, your coverage
matches what the vendors actually host. DeepSeek publishing only `deepseek-v4.1-flash` and
`deepseek-v4-pro` on `deepseek/direct-api` is correct; z-ai's 11 and MiniMax's 8 are their current
lineups.

What is left after that filter is a handful we believe the vendor does host:

| Model | Expected route | Note |
|---|---|---|
| `glm-4.5v`, `glm-4.6v`, `glm-5v-turbo` | `z-ai/direct-api` | Z.ai's own API serves its vision models |
| `glm-4.7-flash` | `z-ai/direct-api` | the rest of the 4.7 line is mapped |
| `kimi-k2-0905` | `moonshotai/direct-api` | |
| `minimax-m2-her`, `minimax-m1` | `minimax/direct-api` | |

Each may have a reason we cannot see — a retirement, a region, a different endpoint. Treat the list
as a question rather than a defect report.

## Which of your routes claudish can execute, now that routing reads the catalog

claudish now builds every bare-name routing chain from your connections — the hand-written table
of globs is deleted. That makes your route bindings load-bearing in a way they were not before, so
here is the full census of generation `g-20260921062451697-f490edba`, 28 distinct mapped route
pairs, so you can see exactly where we land:

**25 of 28 execute.** `openrouter/gateway` (523 connections), `poe/gateway` (341),
`together-ai/gateway` (244), `qwen/dashscope-direct` (136), `openai/direct-api` (130),
`opencode/zen` (75), `google/direct-api` (46), `opencode/go-subscription` (37),
`qwen/qwencloud-token-plan` (31), `fireworks/gateway` (26), `ollama/cloud` (24),
`mistralai/direct-api` (20), `sakana/direct-api` (12), `anthropic/claude-code-subscription` (11),
`z-ai/direct-api` (11), `qwen/modelstudio-coding-plan` (10), `minimax/direct-api` (8),
`x-ai/direct-api` (7), `openai/codex-subscription` (5), `moonshotai/kimi-code-subscription` (4),
`moonshotai/direct-api` (4), `deepseek/direct-api` (2), `z-ai/glm-coding-subscription` (2),
`minimax/coding-plan-subscription` (2), and `vertex/google-cloud` through our own discovery.

**Three do not, and only one is a question for you:**

| Route | Connections | Why |
|---|---|---|
| `opencode/systemone` | 2 | **Please confirm what this profile is.** We have never seen it and it binds to no claudish provider, so those two models are unreachable here. If it is a product we should support, we will add the binding. |
| `qwen/realtime-websocket` | 8 | Correct to skip: a WebSocket realtime API, and claudish has no transport for it. No action wanted. |
| `openrouter/decisions` | 2 | Correct to skip: its `outputModalities` is `["decisions"]`, so it is not a chat model. No action wanted. |

One more, ours rather than yours, recorded so the census is complete: `anthropic/direct-api` (11
connections) binds to a claudish provider name that has no definition, so we cannot execute it
today. That is our gap to close, not a defect in your data.

## `glm-5.3` is published with a thinking toggle it does not have

Found while verifying our v10 release. The catalog gives `glm-5.3` a reasoning capability whose
`control` reads as a toggle, so claudish offered the off-switch. Z.ai refuses it. Measured against
`api.z.ai` on 2026-09-22 with `glm-5.3`:

```
{"thinking":{"type":"disabled"}}                          -> 400 code 1210
   "This model always engages in thinking and cannot be disabled;
    please use low, high, or max"
{"thinking":{"type":"enabled"},"reasoning_effort":"low"}  -> 200
```

So the model's real control is an effort level with no "off", and the advertised levels are
`low`, `high`, `max`. The Flash variants (`glm-5.3-flash`, and the one `glm-coding` picks) still
accept `disabled`, so this is per-model rather than family-wide — which is exactly the kind of
distinction only the catalog can carry.

We have worked around it in our probe, and that workaround is ours to delete once the capability
is right. What would fix it properly on your side is publishing, for a model that cannot stop
reasoning, a control that has no disabled state — we read `reasoning.control` and
`reasoning.efforts` and will follow whatever they say.

## Nothing else outstanding from our side

The two design answers we sent still stand: unknown modalities as an absent field are right for
us, and we order tiered prices by the first tier, never averaging tiers and never choosing a tier
from a request's size. Modalities are in use now — the catalog's `outputModalities` decides
whether claudish offers a model as a chat model, in both directions, and 16 models whose names
look non-chat but whose published output includes text stopped being hidden by our old name rule.
