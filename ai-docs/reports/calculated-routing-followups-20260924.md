# Calculated routing: what shipped in 10.3.0, and what is still open

Date: 2026-09-24. Branch `fix/v3-reader-gaps`, released as claudish 10.3.0. Catalog generation
for every measurement below: `g-20260923145315478-d7a326bd`.

## What shipped

- One explained route (`explainRoute`, `providers/routing-rules.ts`). `route()` is derived from
  it, and `--probe`, the config TUI's route probe and the team grid header render it. `route()`
  output was byte-identical on 1,156 targets after the derivation.
- Bare non-Claude names reach `route()`. Before, 508 of 1,143 catalog ids (266 chat models, for
  example `o4-mini`) matched none of the 45 `nativeModelPatterns` and went to the native
  Anthropic passthrough. Claude Code's own names (`opus[1m]`, `opusplan`, `best`, `claude-*`)
  stay native.
- `defaultProvider` works at runtime, from `--default-provider`, `CLAUDISH_DEFAULT_PROVIDER` and
  config, and `""` means no fallback. Before, the proxy always fell back to OpenRouter.
- `CATALOG_ROUTE_BINDINGS` holds claudish providers only; `anthropic`, `moonshotai` and `zen`
  moved to `LOOKUP_ONLY_ROUTE_BINDINGS`.
- An upstream 502/503/504 advances a bare-name chain (`isRetryableError`,
  `handlers/fallback-handler.ts`). Rationale: `ai-docs/architecture/adapters.md`, "An unavailable
  endpoint advances the chain".
- The two subscription tiers form one band, so a vendor's own dynamic subscription leads:
  `grok-4.6`/`grok-4.7` go Grok Build → OpenCode Zen Go → xAI.

## How it was verified

- Full suite: packages/cli 4460 pass / 36 skip / 0 fail (290 files), macos-bridge 20/0,
  scripts 5/0, on Bun 1.4.0 with `CLAUDISH_SKIP_LIVE_E2E=1 bun run test:safe`. Every new test was
  mutation-checked: it fails with its fix removed.
- Route-table gate (`scripts/route-table-snapshot.ts diff --strict`): the only differences were
  the intended 508 native → routed decisions, and later exactly two reordered chains
  (`grok-4.6`, `grok-4.7`).
- Live, in a terminal pane, 16 routing scenarios (probe and real prompts) passed. The 503 fix was
  checked against a real outage: with OpenCode Zen Go answering
  `503 Upstream request failed: Endpoint is unavailable.` and a project rule
  `"grok-4.7": ["zengo", "x-ai"]`, claudish 10.2.0 sent the request to Zen Go 7 times in 45 s
  with no reply; the fixed build logged `[Fallback] OpenCode Zen Go failed (HTTP 503), trying
  next provider...` and answered through xAI in 4 s.

## Open defects, seen and not fixed

| Defect | Where | Impact |
|---|---|---|
| An uncredentialed `poe:x` falls through to the native handler at runtime while `explainRoute` reports `no-credential` | proxy `poe` branch | display and runtime disagree |
| `route()` returns `ok` but zero handlers get built → the request falls through to the native handler | `proxy-server.ts`, bare-name branch | predates 10.3.0 |
| `hasNativeAnthropicMapping` treats `anthropic/<id>` as native and keeps Claude Code's auth, while the proxy sends that id to OpenRouter | `claude-runner.ts` | predates 10.3.0 |
| The catalog-empty no-route hint opens with "No credentials found for …" | `routing-rules.ts` hint text | wrong cause named |
| `Run: claudish login kimi` prints twice for `kimi-k3` (kimi-coding and kimi) | credential hint | cosmetic |
| `--probe -d` writes no debug log: the probe never initialises the logger | `cli.ts` probe path | no log to read |
| The `route:` line on the probe's Details tab wraps without its indent | `probe-tui-app.tsx` | cosmetic |
| `packages/macos-bridge/src/bridge.test.ts` writes the real `~/.claudish-proxy/bridge-token`, which `guard-real-config` does not cover | test suite | touches real state |
| `--probe` misreads explicit targets that are not `provider@model`: a URL target (`http://localhost:11434/llama3`) is dropped as `no-credential` for the parser-only `custom-url` provider and never probed; a legacy spec (`oc/llama3.2`) is shown with provider `oc/llama3.2`. `explainRoute` passes `decision.spec` (the raw target) to `explainExplicitSpec`, which reads it as a routing-rule entry. Real requests are unaffected (the proxy serves these without `route()`), and `route()`'s answer for them is unchanged from 10.2.0; the display regressed because `--probe` renders `explainRoute` since 10.3.0. Fix: build the explicit candidate from the parsed provider and model, and give URL targets their own explanation with the proxy's URL credential policy. Found by the 10.3.0 release review, source-traced, not yet reproduced live | `routing-rules.ts` `explainRoute` / `explainExplicitSpec` | display only |

The same review found a billing regression, fixed before release: a stream-head retry that could
not reach the provider answered an unmarked 503, which the new 502/503/504 rule would have
advanced onto the next, possibly metered, candidate. It now carries `x-claudish-connection-error`
and holds the chain (`adapters.md`, "An unavailable endpoint advances the chain").

## Deferred on purpose

- **The 43 non-Claude `nativeModelPatterns`.** They no longer decide native versus routed, but
  still strip a `vendor/` prefix, steer startup key validation, steer `advisorRouteFor`, feed the
  catalog-empty hint and supply the 4 namespace claims. Removing them is its own design.
- **`pickerProviderToFirebaseSlug`** (`model-selector.ts`) reads four subscription providers from
  their metered route; changing it changes what the picker offers and needs a live check per
  account.
- **`advisorRouteFor`** (`native-handler-advisor.ts`) is a second router, for `--advisor` only.
- **Docs drift:** `docs/settings-reference.md` §6-7 describe removed behaviour (and still say
  project rules "entirely replace" global ones; they merge per pattern); `routing.md`'s
  hand-written "Provider Shortcuts" list misses about ten shortcuts; "Firebase catalog", a
  Never-write term, appears at six places in `cli.ts`; `cli.ts` error examples name concrete
  model ids.
- **Small debt:** the dead field `legacyAutoPromoted`; two copies of the label
  `"Claude Code's own auth"`; the 7 skips added during the work are not attributed to files.
