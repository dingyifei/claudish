# `grok-4.6` routed to Zen Go with no fallback — a stale 9.0.2, not a live defect

Investigated 2026-09-07 after a `team` slot for bare `grok-4.6` failed:

```
claudish --model zengo@grok-4.6 -y --stdin ...
[claudish] Error [Zen Go]: HTTP 401. Model not supported by this provider.
Verify model name. (Model grok-4.6 is not supported for format oa-compat)
```

and `preflight` reported the chain as `OpenCode Zen Go` with **no fallback**, while every
sibling model showed `(+2 fallback)`.

## Verdict

Not a live bug and not a backend data error. The route was computed by **claudish 9.0.2**,
which carries the catalog-merge defect fixed in 9.0.3 (#230). The machine auto-updated to
9.0.4 mid-session. No models-index bug report is warranted.

## Evidence

`~/.claudish/startup-metrics.jsonl` logs the version of every launch:

```
"ts":"2026-09-04T11:26:32.332Z","version":"9.0.2"   <- the failing grok-4.6 slot
"ts":"2026-09-04T11:26:32.333Z","version":"9.0.2"
"ts":"2026-09-07T01:37:40.975Z","version":"9.0.2"   <- Phase B team children
"ts":"2026-09-07T01:47:21.274Z","version":"9.0.2"   <- old binary, update-check span
"ts":"2026-09-07T01:47:38.661Z","version":"9.0.4"   <- every launch since
```

`~/.bun/install/global/node_modules/claudish/` mtime: `2026-09-07 11:47:27` local.

The MCP server processes serving this session started at 11:40:03 local, so they loaded
9.0.2 and kept it in memory after the on-disk bundle became 9.0.4. `lsof` on the process
shows no claudish bundle mapped (Bun loads and closes), so this could not be confirmed
from the process itself; the metrics log is the proof.

## What 9.0.2 did

`routing-rules.ts:50-66` (post-fix) documents the mechanism: v9.0.1 merged catalog
subscription data into the routing rules as EXACT keys, and `matchRoutingRule` returns on
the first exact hit before consulting globs. The catalog says `grok-4.6` has
`subscriptionPlans: ["opencode-go"]`, so it produced `"grok-4.6": ["opencode-zen-go@grok-4.6"]`,
which shadowed the `grok-*` glob and deleted `x-ai` and `openrouter` from the chain.
That comment's own worked example is this exact model.

## What 9.0.4 does — reproduced from source

`ai-docs/sessions/dev-fix-preflight-20260904/repro-grok-route.ts`, run against the
worktree at `acf18bb`:

```
route("grok-4.6") ->
  primary:   gk@grok-4.6      grok-subscription (Grok Build)
  fallback:  x-ai@grok-4.6    x-ai
  fallback:  x-ai/grok-4.6    openrouter
```

Zen Go is absent, matching `default-routing-rules.ts:57`
(`"grok-*": ["grok-subscription", "x-ai", "openrouter"]`) and the deliberate exclusion
explained at `:191-194`. The installed 9.0.4 bundle carries the same rule (grepped).

## The backend data is correct

Zen Go's LIVE `/v1/models` roster, fetched during the repro, lists 35 models including
`grok-4.5` and `grok-4.6`. The `opencode-go` plan's `includedModels` in the hosted catalog
lists the same. Provider and catalog agree. Nothing to report to models-index.

(`~/.claudish/zen-go-models.json`, dated 2026-05-09, lists 14 models and no grok — that
file is a stale cache from a different code path and is not what routing consults; the
live discovery cache has a 5-minute TTL.)

## One genuine oddity, narrow, not fixed

Zen Go's `/v1/models` says it serves `grok-4.6`, but its OpenAI-compatible chat endpoint
(`/zen/go/v1/chat/completions`, `transport: "openai"` in `provider-definitions.ts:808`)
rejects it with `401 ... not supported for format oa-compat`. The Go plan advertises
"OpenAI-compatible, Anthropic-compatible, and provider-specific Go endpoints", so grok
models are probably reachable only through a non-OpenAI endpoint on that host.

Blast radius: only an explicit `zgo@grok-4.6` or `zgo@grok-4.5`. Bare names never reach
Zen Go for the grok family on 9.0.3+. Worth a measurement against the Anthropic-compat
and provider-specific Go endpoints before touching the provider definition.

## Action for the user

Restart the MCP server (new Claude Code session, or reconnect the claudish MCP) so it
loads 9.0.4. The on-disk install is already correct; only the long-running processes
started before 11:47 still hold 9.0.2.
