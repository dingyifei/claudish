# Remaining work on the claudish side

> **Revision 5 note, 2026-09-22 — v10.0.0 RELEASED.** Merge `91120dd6`, tag `v10.0.0`, CI green
> (typecheck, lint, hermetic tests on macOS with pinned bun 1.3.10), four platform binaries built,
> GitHub release live with 10 assets, `npm publish` returned `+ claudish@10.0.0` with provenance,
> Homebrew updated. Two things CI caught that local runs could not: a secret-shaped test fixture
> (GitHub push protection, correctly), and two tests asserting that a bare name still routes with an
> EMPTY catalog — true only under the deleted table, and passing locally only because
> `~/.claudish/codex-oauth.json` exists and triggered an early return.
>
> Still open at the time of writing: `claudish@10.0.0` 404s at its per-version manifest with no
> `time` entry and no `unpublished` marker, while the four `@claudish/magmux-*` packages already
> answer 200. That is the staged-publish signature from v9.3.1, which cleared itself in ~20 minutes.
> If it does not clear, the number is burned and recovery is 10.0.1 — OIDC means nothing can be
> published from a developer machine.
>
> **Deferred out of v10, deliberately:** 4.2 (return the incompleteness of a model list rather than
> only recording it), the source half of the vocabulary pass ("served set", 24 sites), Vertex 3.6's
> interactive checks, and `anthropic/direct-api`, which binds to a claudish provider name that has no
> definition — pre-existing, and it does not affect bare Claude names because those resolve through
> `nativeRouteFor()` before `route()` runs.

> **Revision 4 note, 2026-09-22.** Phase 2 is DONE and behind its gate (`af98f4f2`): routing now
> gathers candidates from the catalog, `default-routing-rules.ts` is deleted, and all 836 lost hops
> classify as design decisions with zero cases where the catalog maps a provider and routing dropped
> it. The gate caught one real defect on the way — `glm` and `z-ai` are one endpoint under two key
> silos and only one was bound. Vertex 3.4 and 3.5 are done; its publisher listing over-reports
> (132 rows, 8 actually served), so each candidate is confirmed before being offered. Remaining:
> Codex's test rewrite (the suite is red until it lands), the source half of the vocabulary pass,
> 4.1, 4.2, Vertex 3.6, and the release. The sections below are revision 3 and are superseded where
> they disagree.

**Revision 3, 2026-09-21.** Branch `fix/v3-reader-gaps`. Nothing pushed, CI has never run on this
branch, nothing released.

What changed since revision 2: the backend shipped BOTH remaining items — the pricing discriminator
is now `type` and Poe has a verified probe pick — so Phase 1 is finished, not merely unblocked. The
Vertex ADC refactor's first three items are done and live-verified. One defect was found that was
not in any plan: the catalog quotes a metered price of zero on 167 connections, which would have
made routing prefer them.

Every decision below is Jack's unless marked **DISCUSS** (needs a decision) or **RESEARCH** (needs a
measurement). Sizes are agent-hours including live verification.

---

## Done since revision 2

All verified against live data on generation `g-20260921062451697-f490edba`, not against fixtures.

| Item | Commit | Evidence |
|---|---|---|
| 1.1 Modalities decide chat capability | `7fce457` | 543 models chat and 270 excluded by catalog evidence, 51 still unknown; 16 models that write text stopped being hidden by their names (`gpt-5-image`, `gemini-3.1-flash-image`, `qwen-audio-3.0-realtime-plus`) |
| 1.2 Comparable price per connection | `7fce457` | 923 of 1,734 mapped connections priced; `qwen3.7-flash` reads `$0.16/M` from its first tier, never the `0.553` mean |
| 1.3 `shape` → `type` | `7fce457` | Backend cut over; `shape` is gone from the wire entirely, so claudish reads `type` with no alias, as agreed |
| 1.4 Poe probe pick | verified, no code change | `poe/gateway` → `gemini-3.8-flash` reaches our probe path; `App.tsx:1342` already prefers the catalog pick over discovery |
| Zero-price defect (NEW) | `9bedcf7b` | A `flat`/`tiered` price summing to zero is unknown, not free; connections reading as free fell from 197 to exactly the 30 that declare it |
| 3.1–3.3 Vertex on ADC | `ae785275` | `buildsOwnEndpoint` keeps Vertex in the registry; project resolves from env → ADC `quota_project_id` → `gcloud config`; Express deleted across 17 references; live token obtained with no env var set |
| The routing gate | `182116eb` | `scripts/route-table-snapshot.ts`; baseline of all 1,123 models captured on the current generation |

Tests were authored by Codex with a mutation proof on every load-bearing case: each was shown to
fail with its fix reverted, and the implementation restored byte-for-byte afterwards.

---

## What the gate measured, and why Phase 2 matters more than we thought

Today's routing sends **417 chat models to a final hop the catalog never mapped.** Only 492 of 1,123
models have an OpenRouter connection, yet 1,109 chains end at an OpenRouter-style hop, because the
hand-written table carries `"*": ["openrouter"]` (`default-routing-rules.ts:152`). For those models
the catalog already names a provider that does serve them: Poe 241, Together 163, Alibaba metered
100, OpenAI 74, Google 22.

`qwen3.8-max` is the worked example. It has four mapped connections, none of them OpenRouter, and
today's chain is `qtoken -> zengo -> qpay -> openrouter`, whose last hop cannot succeed. Fireworks,
which the catalog says serves it, is absent entirely.

Two consequences for the design:

1. The fallback MUST default to OpenRouter when `defaultProvider` is unset, or deleting the table
   removes the last hop from 1,109 models at once. Jack's decision already says the fallback exists,
   is optional and can be any aggregator; this makes its default explicit.
2. Rule 2.4 is real and now has a precise form. `providerServesModel("openrouter", "qwen3.8-max")`
   returns `unknown`, so the dead hop survives the availability filter. The asymmetry ("only a
   positive no removes a hop") is right for a subscription, whose membership we cannot enumerate,
   and wrong for a gateway whose complete connection list the backend publishes. The catalog itself
   distinguishes them: a route marked `client_model_selection_required` is account-selected, so
   absence stays unknown; any other route is backend-owned, so absence IS denial.

---

## Phase 2 — the routing redesign

**Decided.** One order: user rules → subscriptions → dynamic subscriptions → native API → gateways →
fallback. Inside a tier: the model's own vendor first, then cheapest by catalog price, then the
larger context window, then provider name for determinism. No local preference list, no local state.

Two facts found today remove work from this phase:

- **Subscriptions are already connections.** `aggregators[]` carries `moonshotai/kimi-code-subscription`,
  `openai/codex-subscription`, `z-ai/glm-coding-subscription`, `qwen/qwencloud-token-plan` and
  `opencode/go-subscription` beside the gateways. One source covers every tier; only the tier itself
  comes from claudish's provider table.
- **The vendor needs no local table.** `route.routeId === entry.provider` identifies the vendor's own
  route. True for 412 models; the other 709 are served only by gateways, which is a fact about those
  models rather than a gap.

### 2A Candidate gathering (in progress)
A `tier` on every provider definition plus one pure module `providers/route-candidates.ts`, gathering
from catalog connections and from namespace claims for the four dynamic subscriptions the catalog
cannot publish. Nothing is wired in; `scripts/route-candidates-preview.ts` compares what it WOULD do
against today's chain for all 1,123 models.

### 2B Wiring, and deleting the table (L, ~6h)
Replace the first step of `routeBare` — matching the merged table — with candidate gathering. The
credential filter and the availability filter after it are unchanged and must not be duplicated.
Delete `default-routing-rules.ts`, `buildCatalogRoutingRules`, `retainKnownCatalogRoutingRules` and
`mergeRoutingRules`; `loadRoutingRules()` then returns the user's own rules verbatim.

Known scope beyond routing: the TUI shows which user rules "override a default"
(`App.tsx:650-670`, `RoutingContent.tsx:382-385`). With no defaults left, that concept disappears
and those views need to show the effective chain instead.

### 2C The gate (M, ~3h)
Capture after, diff against the committed baseline, review by hand. Every difference must be a
deliberate addition or a removal this design names. Then Test All, a cold-cache run, and a real
session on two subscriptions.

**DISCUSS:** nothing outstanding. The tie-break inside a tier was decided on 2026-09-21: larger
context window, then provider name.

---

## Phase 3 — Vertex, the rest

| # | Work | Size |
|---|---|---|
| 3.4 | Readiness and the Providers tab. The credential authority is already correct via `resolveVertexConfig`; what remains is `--probe`'s provenance display, which still reports on `VERTEX_PROJECT` alone and so can call a working Vertex unconfigured (`api-key-map.ts:58`, consumed in `cli.ts`) | M, ~3h |
| 3.5 | Probe pick from the project's publisher models, newest first. The catalog will never supply one: Vertex is `client_model_selection_required` by agreement, which is correct | M, ~3h |
| 3.6 | Live validation and tests: a Gemini publisher model, an Anthropic publisher model, streaming, the 401 refresh | M, ~3h |

**RESEARCH.** Service-account credentials are a shape never exercised here; per-location model
availability means a pick verified on one project may 404 on another; Anthropic-on-Vertex uses
`rawPredict` with its own payload. Codex also reported four branches of project resolution that
cannot be tested without an injected ADC reader and command runner — worth adding those seams.

---

## Phase 4 — tests and debt

### 4.1 The eleven fixes of 2026-09-19/20 (M, ~3h, Codex writes)
Still outstanding. Today's Codex runs covered the NEW work only. The eleven are: the Gemini probe
effort, the parameter-versus-model hint, Mistral's model list, Poe's pick and transport method, the
discovery retries, the 403 access-denied hint and its classification, the DeepSeek
effort-versus-thinking conflict, the local 401 message, the newest-first ranking, and the Alibaba
metered effort enum.

### 4.2 An incomplete list must stay visible (S, ~1h)
Unchanged from revision 2: return the incompleteness rather than only recording it.

### 4.3 Vocabulary (S, ~2h) — sequence AFTER 2B
"served set" has 24 sites, and `routing-rules.ts` and `default-routing-rules.ts` hold most of them.
The second file is deleted by 2B, so renaming words in it now is wasted work.

### 4.4 Two small defects (S, ~1h)
Redact `readinessDetail` before anything displays it. The `[object Object]` probe error was hunted
today and is NOT in `probe-discovery.ts`, `probe-catalog.ts` or `probe-live.ts` — every failure path
there builds a string. It needs its reproduction (the Mistral candidate walk) to locate.

---

## Phase 5 — release 9.8.0

Unchanged: finish the phases, suite green, Test All re-run, push onto PR #266 so CI runs for the
first time, bump both manifests, regenerate `version.ts`, tag the merge commit by explicit ref, watch
the release workflow, verify the published version. Then delete the `QWEN_CLOUD_PLAN_API_KEY`
Keychain item, remove the 5 duplicate lines in `.env`, and remove the four `worktree-agent-*`
worktrees.

**Before the worktree is reaped:** `ai-docs/sessions/dev-feature-catalog-phase1-20260921-0015/`
holds the implementation notes and probe scripts from today and is gitignored. Anything durable in
it must be promoted to `ai-docs/` or `docs/` first. The measurements themselves are already in this
file and in the commit messages.

---

## Outstanding with the backend

Written up in `ai-docs/reports/BACKEND_zero_prices_models_index-20260921.md`:

1. 167 connections quote `type: "flat"` with `input: 0, output: 0`; 163 are `together-ai/gateway` on
   models Together AI charges for. Zero is the strongest possible price, so a missing measurement
   PROMOTES those connections. Please publish `unavailable` instead. claudish's workaround is meant
   to be deleted, not kept.
2. `opencode/systemone` (2 connections) resolves to no claudish provider — is it a new profile we
   should map? The other two unmapped routes need nothing: `qwen/realtime-websocket` is a WebSocket
   API with no chat transport here, and `openrouter/decisions` publishes `["decisions"]` output.

---

## Deferred, with the reason

- **Alibaba metered** until after the v3 release. Nine of nine request shapes and models are denied
  on `dashscope-intl` while the same key lists 169 models; the account's model access is the cause.
- **The public-list rule (old group D).** Catalog membership already gates the Coding Plan.
- **Alibaba Coding Plan** while the stored key is the Token Plan key.

---

## Suggested order

2A's preview, reviewed by hand, then 2B behind its gate, then 4.3 (whose targets 2B rewrites), then
Vertex 3.4 to 3.6, then 4.1, 4.2 and 4.4, then the release. Roughly 20 to 25 agent-hours remain,
down from 30 to 35 at revision 2.
