# Bug report: the catalog v3 cutover broke every released claudish

**For:** the models-index backend developer
**From:** claudish (client side)
**Date:** 2026-09-19. All times below are UTC on 2026-09-18.
**Status:** open. Every released claudish build currently has no model catalog.

## Summary

| # | Severity | Finding |
|---|---|---|
| 1 | Critical | The v3 cutover went live 19 days before the agreed earliest date, before its claudish prerequisites were met. Every released claudish lost its catalog at once. |
| 2 | High | OpenRouter is gone from the catalog. It was on 493 of 908 v2 entries. It is on 0 of 538 v3 entries, with no plan and no probe route. It is claudish's default backend. |
| 3 | High | v3 went live before any generation was active. For at least an hour, a correct v3 client received `503 catalog_unavailable`. |
| 4 | Medium | `/probeModels` v3 publishes no probe model for three `supported` route profiles, and none for OpenRouter, together-ai, fireworks, poe or vertex, all of which v1 covered. |

The 426 envelope itself is correct. It matches the frozen contract byte for byte. Claudish 9.7.0 parsed it from the live server and recorded `minimumContractVersion: 3`. The contract design held; the rollout did not.

## Timeline (measured)

| Time (UTC) | Observation | Source |
|---|---|---|
| 03:53:23 | The last successful v2 refresh on a real client | `lastUpdated` in `~/.claudish/all-models.json` |
| before 06:23 | `queryModels` and `queryPlans`: **426** without the v3 `Accept` header, **503** with it | curl, below |
| 06:23:45 | claudish's guard, run against the live server, records `serverContractVersion: 3` | sentinel written by the guard |
| 07:23:14 | Generation `g-20260918072314542-9c5a9567` generated | `generatedAt` on v3 bodies |
| 14:46 | claudish 9.7.0 published, the first build that understands the 426 | npm, GitHub release |
| 14:48 | v3 answers 200: 538 models, 19 plans | curl, below |

## Finding 1: the cutover went live before its recorded prerequisites

Your reply to our feedback (`REPLY_FEEDBACK_catalog_contract_v3-20260909.md`, section D2) records:

> The replacement plan names **2026-10-07 as the no-earlier-than cutover date** … The plan forbids moving earlier without a newly reviewed safety decision.

It lists six prerequisites. Two of them concern claudish, and neither was met:

| Prerequisite | State at the cutover |
|---|---|
| "a Claudish safety release shipping first" | **Not met.** 9.7.0 reached npm 8 to 11 hours after the cutover, which fell between 03:53 and 06:23. |
| "a v3-capable Claudish build passing emulator acceptance" | **Not met.** No v3-capable claudish build exists yet. |

If a newly reviewed safety decision authorised the earlier date, this finding is about its consequences, not the decision.

**Impact on users, today:**

| claudish version | What the user sees |
|---|---|
| 9.6.1 and earlier, no cache (every fresh install) | Exit code 1 with `Error: cannot reach model catalog and no cached copy found.` and the advice "Check network connection". The network is fine. (From the 9.6.1 code path: the 426 is classified as a generic HTTP error.) |
| 9.6.1 and earlier, warm cache | Runs on a v2 cache frozen at the cutover, with no message. The cache never refreshes again. |
| 9.7.0 | "This claudish build cannot read the model catalog … contract version 3". Explicit `provider@model` specs still work. Bare model names do not. |
| every version, `claudish config`, then Test All | Before our hotfix, every configured provider fails with "could not reach model catalog (http)" without being contacted. Observed on 9.7.0: 18 of 18. |

No released claudish sends the v3 `Accept` header, so no released claudish can read the catalog.

**Ask:** until the recorded prerequisites are met, answer requests **without** the v3 `Accept` header with the v2 responses, as before the cutover. That restores every installed claudish at once. If a v2 projection can no longer be produced from the v3 generation store, tell us, and we will treat the v3 reader as an emergency.

## Finding 2: OpenRouter is absent from v3

| | v2 (client cache, 03:53) | v3 (live, 14:48) |
|---|---|---|
| model entries | 908 | 538 |
| entries with an OpenRouter row | **493** | **0** |
| OpenRouter in any plan | — | no |
| OpenRouter in `/probeModels` | yes (`deepseek/deepseek-v4-flash-0731`) | no |

The string `openrouter` does not occur anywhere in the 538 v3 model rows, the 19 plans, or the probe routes. The v3 `sourceProviderId` values that do occur are: deepseek, fireworks, google, kimi-code, minimax, minimax-token-plan, mistralai, moonshotai, ollamacloud, openai, openai-codex, opencode-go, opencode-zen, qwen, qwen-cloud, qwen-coding, sakana, together-ai, x-ai and z-ai.

OpenRouter is claudish's default backend and the last hop of most routing chains. Without it in the catalog, claudish cannot map a model to OpenRouter's wire id under v3.

**Ask:** is this deliberate? If yes, tell us how v3 expects a client to route to OpenRouter. If no, restore it. The 370 entries that disappeared between v2 and v3 may be the same cause.

## Finding 3: v3 went live with no active generation

Before 06:23, both endpoints answered a correct v3 request like this:

```
$ curl -s -H 'Accept: application/vnd.models-index.catalog+json;version=3' \
    'https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=1000'
HTTP 503
{"contractVersion":3,"error":{"code":"catalog_unavailable","message":"No active catalog generation is available"}}
```

The generation that now serves was generated at 07:23:14. So a v3 client got 503 for at least an hour, and a v2 client got 426 for the same period. No client of any version could read the catalog in that window.

**Ask:** in future deploys, build and activate the generation first, then enable the `Accept` gate. The `503` envelope was correct; the order was not.

## Finding 4: `/probeModels` v3 coverage dropped

The claudish TUI's Test All uses `/probeModels` to pick the first model to try on each provider. v1 had picks for 29 provider slugs. v3 has 19 route profiles.

These route profiles are `supported` in `queryPlans`, but have no entry in `/probeModels`:

- `google/antigravity-subscription` (plan `google-antigravity`)
- `x-ai/supergrok-subscription` (plan `xai-supergrok`)
- `cognition/devin-subscription` (plan `cognition-devin`)

These had v1 picks and have no v3 route at all: `openrouter`, `together-ai`, `fireworks`, `poe` and `vertex`. together-ai is the most common `sourceProviderId` in v3, at 239 rows.

**Ask:** publish a probe model for every route profile that `queryPlans` marks `supported`. If one cannot be chosen server-side because the roster is per-account (`modelDiscovery: client`), say so in the response rather than omitting the key, so a client can tell "no pick" from "unknown route".

## What claudish has done

| Build | Change |
|---|---|
| 9.7.0 (released 14:46) | Detects the 426, or a newer `contractVersion`, on both endpoints. Names the cause instead of blaming the network. Warns and proceeds instead of exiting 1. Explicit specs keep working. |
| 9.7.1 (in progress) | Test All no longer fails every provider when `/probeModels` is unreadable. It tries the last cached pick, which the live probe verifies, then endpoint discovery. Verified live: 14 of 18 pass in Test All and Devin passes on its own, so 15 of 18 work; the other 3 report real quota errors from the providers. |
| v3 reader (next) | Sends the v3 `Accept` header, reads `route` / `routeStatus` / `rosterCoverage`, and paginates by `nextCursor`. It is built against a full snapshot of generation `g-20260918072314542-9c5a9567`. |

## Reproduce

```
# What every released claudish sends: no Accept header
curl -s -w '\nHTTP %{http_code}\n' \
  'https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=5'

# The same request as a v3 client
curl -s -w '\nHTTP %{http_code}\n' \
  -H 'Accept: application/vnd.models-index.catalog+json;version=3' \
  'https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=5'

# Probe routes, v3
curl -s -H 'Accept: application/vnd.models-index.catalog+json;version=3' \
  'https://us-central1-claudish-6da10.cloudfunctions.net/probeModels'
```
