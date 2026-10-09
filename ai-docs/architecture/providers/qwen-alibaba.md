# Alibaba Cloud Model Studio and QwenCloud products

Alibaba Model Studio and QwenCloud are two consoles for the same account. Their
API products have separate credentials and hosts: a key must be used with its
matching product endpoint. An account's dynamic models catalog can differ from
public documentation.

| Product | Anthropic host (+ `/v1/messages`) | Claudish | Credential |
|---|---|---|---|
| Coding Plan | `coding-intl.dashscope.aliyuncs.com/apps/anthropic` | `qwen-coding` / `qcode@` | `QWEN_CODING_PLAN_API_KEY` |
| Token Plan | `token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` | `qwen-token-plan` / `qtoken@` | `QWEN_TOKEN_PLAN_API_KEY` |
| PAYG | `dashscope-intl.aliyuncs.com/apps/anthropic` | `qwen-payg` / `qpay@` | `DASHSCOPE_API_KEY` |

The v3 catalog binds these transports to `qwen/modelstudio-coding-plan`,
`qwen/qwencloud-token-plan`, and `qwen/dashscope-direct`, respectively. A
model's `subscriptionPlanIds` declares published plan membership, while the
matching mapped aggregator connection carries the exact wire ID. Coding Plan
has ten published models, and Token Plan's Individual and Team editions have
20 and 31; verify counts against the current catalog generation when releasing.

For bare Qwen names, the default chain considers Coding Plan, Token Plan,
OpenCode Go, PAYG, then OpenRouter. Each candidate is checked against the
catalog and local credentials. Models from other vendors on an Alibaba product
are explicit `qcode@` or `qtoken@` selections to avoid claiming their entire
vendor namespace.

The Coding Plan `/v1/models` endpoint can respond without authentication, so
its model list alone does not prove a key works. Validate credentialed
inference for account access. Token Plan's model list is authenticated; product
keys cannot be substituted across the three hosts.

## Transport reachability is not product identity

Alibaba's own words: keys and base URLs are "completely isolated and must be used in
matching pairs". **Every silo rejects every other silo's key**, with near-identical
rejections, and that is what makes this rule necessary: a request arriving at the right
host proves nothing about which product the credential belongs to. Where one credential
variable can serve more than one host, product identity lives in a *different* variable
from the key, the two can disagree silently, and the resulting 401 is **indistinguishable
from a bad key** — the silo says "this token is no good", never "you sent me the other
product's token". Discovery fails silently in the same arrangement, because the Token
Plan's `/compatible-mode/v1/models` 404s on `coding-intl` while `coding-intl` serves its
list at `/v1/models`.

So each silo gets a whole entry — name, dedicated credential, billing label, discovery
path — and no entry may be repointed at a sibling's host. Each entry folds
`/apps/anthropic` into `apiPath`, so a single base-URL override moves messages AND
discovery together, and each product owns that override under its own name.

**Verified live** (2026-09-18): each host answers a deliberately bogus key in its own
words, so the reply identifies which host answered:

| Host | Status | Body |
|---|---:|---|
| `coding-intl…/apps/anthropic/v1/messages` | 401 | `invalid access token or token expired` |
| `token-plan…/apps/anthropic/v1/messages` | 401 | `Invalid API-key provided.` |
| `dashscope-intl…/apps/anthropic/v1/messages` | **403** | `invalid api-key` |

Three DIFFERENT rejections, which is exactly what three identical ones could not have
told apart. Note the PAYG row: its Anthropic surface answers **403**, where
`/compatible-mode` on the same host answers 401. Status alone does not identify a silo;
wording does.

Three states, worth keeping apart every time this plan comes up:

| State | Means | Coding Plan today |
|---|---|---|
| **reachable** | requests arrive at the intended silo | **proven** — distinct 401 wording, 2026-09-18 |
| **entitled** | that silo accepts *this* credential | **not proven** — no key exists, none purchasable |
| **built** | claudish has an entry naming and billing it | **true** — `qcode@` → `qwen-coding` |

## The Coding Plan cannot be authenticated here

No Coding Plan key exists on the account these measurements came from, and none is
purchasable: Alibaba restocks slots daily at 00:00:00 (UTC+08:00), first come first
served, and the Lite tier was withdrawn for new subscriptions on 2026-03-20. **No
successful request has ever been made through `qwen-coding`, and nothing in the source
claims one.** The status is VERIFIED-REACHABLE, AUTHENTICATION UNVERIFIED.

Measured 2026-09-17: the stored `sk-sp-` key is rejected by `coding-intl`
**byte-identically to a fabricated key**, on both API surfaces and under all three header
shapes.

| Host / surface | Header shape | Real key | Bogus key |
|---|---|---:|---:|
| `coding-intl…/apps/anthropic/v1/messages` | `x-api-key` | 401 | 401 |
| `coding-intl…/apps/anthropic/v1/messages` | `Authorization: Bearer` | 401 | 401 |
| `coding-intl…/apps/anthropic/v1/messages` | both | 401 | 401 |
| `coding-intl…/v1/chat/completions` | `Authorization: Bearer` | 401 | 401 |
| `token-plan…/compatible-mode/v1/chat/completions` | `Authorization: Bearer` | **200** | **401** (control) |

Every `coding-intl` body is the same string, down to the wording:

```json
{"error":{"code":"invalid_api_key","message":"invalid access token or token expired",
  "param":null,"type":"invalid_request_error"},"request_id":"…"}
```

The Token Plan row is the control, and it is the only reason the four 401s mean anything:
the same probe, the same key, a 200 and a discriminating 401. Without it, five identical
rejections would have been consistent with a broken probe. Anyone who acquires a key
should expect the request path, not the host, to hold the remaining unknowns.

## `sk-sp-` does not identify the Coding Plan

Alibaba's documentation calls `sk-sp-xxxxx` the Coding Plan key format. The measured key
matches `^sk-sp-`, authenticates against **Token Plan** (200, twice, including a live
end-to-end run on 2026-09-18) and is refused by Coding Plan.

- **Sound, and the only conclusion drawn:** a prefix cannot establish which product a key
  belongs to. One counter-example is enough to kill the inference.
- **NOT drawn:** that `sk-sp-` marks "any subscription key". That generalises from a
  single key.

Do not classify a product from a key prefix. A prefix check may at most produce a *hint*
inside an error message, never a routing or billing decision. The 401 recovery hint
(`getRecoveryHint`) names the sibling keys from `siblingKeyEnvVars` and never reads the
key's bytes.

## What Alibaba sells, and how each product meters

| Product | Meters | Quota shape | Editions | Price |
|---|---|---|---|---|
| Coding Plan | **Requests** | ≤6,000 / 5h · ≤45,000 / week · ≤90,000 / month | Pro only | $50 / month |
| Token Plan Individual | **Credits**, tiered per-model coefficients | 7-day rolling window | Lite / Standard / Pro | $6 / $18 / $68 per month |
| Token Plan Team | **Credits**, per seat | seat monthly quota | Standard / Pro / Max | $20 / $75 / $200 per seat |
| Credit Packs | Credits top-up | no window; **expires** | — | $15 · $700 (Team, 625,000 Credits) |
| PAYG | tokens | none | — | per token |

Requests and Credits are different units. Any single "quota" abstraction that assumes
tokens misreports one of them.

The vendor's exhaustion order is **seat quota → Credit Pack (earliest expiry first) →
service suspension.** Alibaba suspends; it never falls through to metered billing. PAYG is
a separate product on a separate key.

## Coverage: four sources, four answers, and no static one is right

| Source | Count | Notes |
|---|---:|---|
| Feature request, Individual | 20 | |
| Feature request, Team | 31 | |
| Alibaba docs, Individual | 24 | includes `qwen-image-3.0-pro` and three `happyhorse` **video** models |
| Alibaba docs, Team | 52 | includes `qwen-image-2.0`, video models |
| **One account, live 2026-09-17** | **25** | includes `qwen-image-2.0`; **no** `happyhorse`, **no** `qwen-image-3.0-pro` |

Coding Plan is the one figure that agrees everywhere: **10**, documented and measured,
excluding `qwen3.8-max` / `qwen3.8-flash`.

Token Plan Team provisions **one API key per member**, so entitlement is per seat.
Coverage is a property of the key, not of the product, which is why no pinned model list
can be correct for an arbitrary user. It is also the concrete case the cloud models
catalog cannot represent: it takes no credential input, so it cannot know what *this*
seat covers. Why the per-account list is never persisted, and which source may deny a
candidate, is in [`routing.md`](../routing.md).

## Neither silo publishes capability or modality

Measured 2026-09-17. The union of keys across every entry, both silos:

```json
token-plan:  { "id": "qwen3.6-plus",      "object": "model", "created": …, "owned_by": "system" }
coding-plan: { "id": "qwen3-coder-plus",  "object": "model", "created": …, "ownedBy":  "system" }
```

No modality field, no capability field, no type field. Two consequences:

1. Capability must come from claudish's cloud models catalog or from name patterns, never
   from the silo. A model on the subscription but absent from the catalog has **unknown**
   capability, and unknown must not silently mean "chat": `qwen-image-2.0` and
   `wan2.7-image` sit on the measured account's list and are image generators.
2. **The owner field's casing differs between silos**: `owned_by` versus `ownedBy`. A
   field read under one spelling is `undefined` for the other, silently. The shared
   `openai-models-list` parser reads neither today; any future read must handle both.

The vendor docs do carry capability hints in prose ("qwen3.7-plus (vision)",
`happyhorse-1.1-t2v` = text-to-video), but transcribing those into source is the
hardcoded model list the repo invariant forbids. `NON_CHAT_PATTERNS` caught every non-chat
id on both live lists and missed exactly three, all video generators on editions the
measured account does not hold; only a cross-edition check found them. The name patterns
are gone since v10.1.1: chat capability now comes from the provider's own listing or the
catalog's published modalities (text among inputs AND outputs), and an id nothing
describes is not offered at all, so an undescribed video generator no longer slips through.

## Measurement traps, all of which cost real time

- **`coding-intl…/v1/models` is PUBLIC.** It returns the full 10-model list with a bogus
  key **and with no auth header at all**, re-confirmed 2026-09-17 alongside the 401
  probes above. A 200 there proves nothing about a credential. Always re-test a list
  endpoint with a deliberately bogus key before believing it. By contrast
  `token-plan…/compatible-mode/v1/models` IS authenticated, provable because a fake path
  under the same prefix 404s while the real path 401s.
- **The Coding Plan list path is `/v1/models`, not `/compatible-mode/v1/models`.** That
  spelling belongs to the other two silos and **404s** on `coding-intl`, as do
  `/api/v1/models`, `/api/v2/models`, `/v1/chat/models` and `/apps/anthropic/v1/models`.
  Six paths probed, one answered. A 404 here reads exactly like an unauthenticated host,
  so the path has to be settled before any auth conclusion is drawn from it.
  `qwen-coding` declares `modelDiscovery.path: "/v1/models"`.
- **A rule generalised from ONE key.** An earlier source comment said a plan key
  authenticates only against `token-plan`. True for the one Token Plan key probed; the
  actual rule is symmetric across all three silos.
