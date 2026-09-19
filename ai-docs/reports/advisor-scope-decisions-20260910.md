# Advisor scope decisions (archived)

Archived on 2026-09-11 from the gitignored build session
`ai-docs/sessions/dev-feature-advisor-any-model-20260909-0001/scope-decisions.md`, which
`git worktree remove` deletes. Everything below the rule is verbatim.

This is the decision record from the middle of the build, written after a read-only trace of how
panel credentials resolve. It decides which credential and routing problems the build fixed and
which it parked.

Read it as a record of the build, not as a description of later code:

- Line numbers describe the code at that time, not `v9.3.0`.
- Which items were fixed before release is in the "Defects found and fixed" section of
  `advisor-build-report-20260911.md`.
- `research/panel-credentials.md`, which it cites, stayed in the session directory and was not
  archived.
- The one item it parked, subscription-aware panel routing, is tracked in `ROADMAP.md` under
  "Route `--advisor` panel calls through subscription-aware routing".

---

# Scope decisions after the panel-credentials trace

Source: `research/panel-credentials.md` (read-only trace), plus the orchestrator's
own read of `providers/catalog-client.ts:314` and
`handlers/native-handler-advisor.ts:640`.

## Observed

- `resolveModelNameSync(userInput, targetProvider): ModelResolutionResult`
  (`catalog-client.ts:314`). The advisor calls it as
  `resolveModelNameSync("openrouter", rawModelId) ?? rawModelId`
  (`native-handler-advisor.ts:640`): arguments swapped, and the result is an
  object that is never nullish. The OpenRouter request body therefore carries an
  object as `model`. The body is typed `any`, so the type checker misses it.
  Every OpenRouter panel member is affected.

## Reported by the trace (from code, not yet observed at runtime)

- Panel keys resolve lazily in `resolveAdvisorKeys` (`native-handler.ts:33-65`):
  openrouter and openai through the credential authority (env, config, keychain,
  1Password); google by hand, skipping the keychain; the Anthropic collector key
  is only the inbound `x-api-key` header (`native-handler.ts:150`).
- Bare `gpt-5.6-sol` parses to provider `openai` and calls api.openai.com with
  the metered `OPENAI_API_KEY`, never the Codex login. `gemini-3.8-flash` parses
  to `google`. `grok-4.6` parses to `x-ai` and goes to OpenRouter. No panel call
  uses a subscription; even `cx@` and `gk@` specs go to OpenRouter.
- Under OAuth (configuration A) the Anthropic collector gets no key, receives a
  401, and silently falls back to concatenation.
- `cli.ts:2201` help text says `--advisor` "works with any --model". False until
  P4 lands.

## Decisions

| Item | Decision | Reason |
|---|---|---|
| OpenRouter model-id bug | IN | Breaks R3 for every OpenRouter panel member. |
| Google key skips the keychain | IN | Silent empty key; R3/R5. |
| Anthropic collector key | IN: inbound `x-api-key`, else `ANTHROPIC_API_KEY` from the credential authority; never the OAuth bearer. No key: startup refusal. | R3/R5; decided open question 3. |
| Single source for "which endpoint/credential a panel model uses" | IN: one exported pure function in `native-handler-advisor.ts`, used by `buildAdvisorRequest` AND by the startup refusal/notice. | A duplicated copy of the branching is how drift starts. |
| Billing disclosure | IN: the startup notice names each panel model's endpoint and says it bills per token; the panel does not use subscriptions. | CLAUDE.md billing invariants; N2. |
| Panel through subscription-aware routing (`cx@`, `gk@`, ...) | OUT, follow-up. Record in `ROADMAP.md` at Phase 8. | Rewrites the retrieval path; the plan's out-of-scope list protects panel behaviour. Disclosure plus refusal make the current behaviour visible. |

## Refinement: default collector vs named collector

`parseAdvisorFlag` (`cli.ts:159`) defaults the collector to `"haiku"` when a
panel has 2+ models and no `:`. Under a Claude Code OAuth session there is
usually no `ANTHROPIC_API_KEY`, so "refuse when an Anthropic collector has no
key" would refuse every default multi-model panel.

| Collector | Cannot be called at launch | Result |
|---|---|---|
| Named by the user | refuse at startup | the user asked for it; predictable |
| Defaulted (implicit `haiku`) | run with no collector (concatenate), notice says why | same end result as today's silent 401 fallback, now visible, one futile call fewer |

Requires recording whether the collector was named or defaulted
(launch-only config field; never in `ClaudishProfileConfig`).
