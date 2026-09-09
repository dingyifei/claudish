> The harness-convention supervisor: rule engine, the four hooks, the plan-mode measurement it was built on, telemetry.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Layer 4: Behavior Compatibility Layer (`behavior/`)

Layers 1-3 translate the wire format, the model dialect, and the transport. Layer 4 translates **harness behavioral conventions** — the unwritten protocols Claude Code expects an agent to follow. A foreign model can speak the wire format perfectly, use every tool correctly, and still break Claude Code by violating one.

**The motivating case.** CC 2.1.220's `ExitPlanModeV2` takes **no** `plan` parameter — its advertised schema is `{allowedPrompts?}` and its description says "This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote". `normalizeToolInput` injects `plan` from disk at the session's assigned path. So `ExitPlanMode({})` is **correct**; the failure is upstream. gpt-5.6-sol wrote a complete 12.9 KB plan under a filename it invented, CC read the assigned path, found nothing, and returned `plan: null` — which downgrades the approval dialog from the rich form (`Yes, and bypass permissions` / `Yes, auto-accept edits` / `Yes, manually approve edits`) to a bare "Exit plan mode?" yes/no. That rich dialog is the **only** surface offering permission elevation on exit, so the session always falls back to `prePlanMode ?? "default"` = manual approval.

Measured over 115 recorded `ExitPlanMode` calls: native Claude 87/87 carried a plan, Kimi-via-claudish 4/4, gpt-5.6-sol 17/24 empty. The discriminator is exact — sessions that wrote to the assigned path got the rich dialog 7/7, sessions that did not got the degraded one 17/17 — and failures ran at ~1.75x the context (178K vs 102K median input tokens). **Not a translation bug**: the same model through the same proxy got the random CC slug right in a shorter session.

## Two pipeline defects this required fixing first

- **`beforeRequest` ran after `buildPayload`.** It is now step **3b**, before step 4. On Chat Completions the old order worked only by accident (`payload.messages = messages` aliases); on **Codex/Responses** `buildPayload` deep-copies both arrays and lifts system into `payload.instructions`, so every middleware mutation was silently discarded on exactly the path gpt-5.x uses. Keep 3b ahead of 4.
- **`openai-responses-sse.ts` had no hooks at all** — no middleware, no `tool-call-recovery`, while `openai-sse.ts` had both. Now wired.

## Design

Rules **return** actions; the engine applies them. Nothing else in the layer mutates the request, which is what makes severity levels meaningful and every change attributable to a rule id.

- **Severity is linter semantics**: `off` / `warn` (log, don't apply) / `fix` (apply). Config resolution is exact id → longest glob → the rule's own default, so `{"plan-mode/*": "off", "plan-mode/plan-file-path": "fix"}` works.
- **`RuleAction` is a closed union** (`injectSystemNote`, `rewriteToolDescription`, `repairToolArgs`, `warn`). An open "run this callback" action would make rule effects unauditable and defeat severity.
- **Sessions, not instance state.** `ComposedHandler` is cached per model and can serve overlapping requests, so detected harness facts live on a per-request `BehaviorSession` captured by the stream-parser closure. Two in-flight turns cannot read each other's plan path.
- **`armed(facts)` gates buffering.** `repairToolArgs` is only possible if a tool's arguments are withheld until the call completes (the Responses parser streams `input_json_delta` the instant each fragment arrives). Buffering is therefore opt-in per tool AND per request: outside plan mode nothing is buffered and streaming is byte-for-byte unchanged. Without `armed`, intercepting `Write` would suppress incremental file-content delivery on every foreign-model request.
- **Repair is wired into every stream format that carries tool calls**, so it is not a Codex-only feature:

| Parser | Providers | How repair lands |
|---|---|---|
| `openai-sse` | GLM, Kimi, Grok, DeepSeek, Qwen, OpenRouter, LiteLLM | Already buffers whenever the request carries tools (`toolSchemas`), so repair hooks the 6 sites that emit a COMPLETE argument object. The incremental `partial_json` fragment path is deliberately **not** hooked — repairing a fragment would emit malformed JSON. |
| `openai-responses-sse` | Codex / gpt-5.x | Streams fragments immediately, so buffering is opt-in per tool via `shouldBufferTool`. |
| `anthropic-sse` | MiniMax, Kimi direct, Z.AI | Byte-level passthrough, so interception is strictly opt-in: only a named tool has its `input_json_delta` frames withheld and rewritten. Verified byte-identical output for untargeted tools. |
| `gemini-sse` | Gemini | No buffering needed — Gemini delivers each `functionCall` with complete `args` in one part. Uses `repairToolArgs`, deliberately separate from the pre-existing `onToolCall` thought-signature hook. |
| `ollama-jsonl` | Ollama local | Not wired — this parser has no tool-call handling at all. |
- **Off for native Claude** (`claude-*` or provider `anthropic`) — a naming rule, not a pinned roster.
- **Anchors live in `harness.ts` only.** `PLAN_MODE_HINT` is a cheap pre-test and **must stay a superset of the anchors** — an earlier version omitted "create your plan at" and short-circuited a valid anchor away. Never assume `~/.claude/plans`: CC has a `planDir` setting, so the path is always taken from the reminder.

## Why the layer is a SUPERVISOR, not a hint system

Claudish routes **arbitrary models, in arbitrary combinations** — a `team` run mixes vendors in one session, and any of them may be swapped tomorrow. There is no capability floor to design against. Specifically, none of the following can be assumed of a model claudish is asked to drive:

- that it follows an instruction it was given many turns ago, under context pressure
- that it invokes a skill, plugin, or tool that is merely *available* to it
- that it knows Claude Code's conventions at all, let alone the current release's
- that it honours the user's own rules (CLAUDE.md, project conventions) rather than taking a shortcut
- that a capability present in one model of a team is present in its siblings

So conformance cannot be delegated to the model's judgement. That is what makes this a supervisor: it enforces from outside rather than asking nicely from inside.

**The measurement this is built on** (plan mode, 115 recorded `ExitPlanMode` calls across 8 models): the plan-file path was in the conversation the whole time — CC re-injects it every turn — and gpt-5.6-sol still wrote to a self-invented filename in 17 of 24 calls, while native Claude was 87/87 correct and Kimi 4/4. The discriminator was context pressure: failures ran at ~178K median input tokens against ~102K for successes. The information was present and the model stopped acting on it, and *which* model it was mattered more than anything else.

The design rule that follows:

> **Put the fact where the decision is made, deterministically. Do not ask the model to go and get it.**

Hence `plan-mode/plan-file-path` rewrites the **ExitPlanMode tool description** rather than re-stating the reminder: a tool description is re-read at the instant the model decides to call the tool, while a system reminder sits 178K tokens away.

Practical consequences for future rules:

- Prefer **injecting content** over instructing the model to fetch it. If a skill matters for the task, inline what it says rather than telling the model to load it.
- Prefer **deterministic repair** over guidance whenever the correct value is knowable.
- Treat "the model was told" as **no evidence** of compliance. Rules are validated by outcome — did the plan file exist at the assigned path — never by whether the instruction was delivered.
- Assume **nothing transfers between models**. A rule proven on one model is a hypothesis on the next; the corpus is per-model for that reason.
- Scoped to **foreign models**. Native Claude honours CC's own mechanisms (hooks, skills, output styles), so the layer stays off for `claude-*` rather than competing with a harness that already works.

*Related reading, as one illustration of the same class from another team: Vercel's [AGENTS.md outperforms Skills in our agent evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) found a skill went uninvoked in 56% of cases, with always-in-context docs scoring 100% against 53% for skills. Single model, and a narrow eval targeting APIs absent from training data — so it is an anecdote about one symptom, not a basis for this design.*

## The four surfaces a rule can observe

| Hook | When | Can it change the turn? |
|---|---|---|
| `onRequest` | before `buildPayload` | yes — `injectSystemNote`, `rewriteToolDescription` |
| `onToolCall` | tool arguments fully accumulated | yes — `repairToolArgs` (requires buffering) |
| `onModelOutput` | after the response stream completes | **no** — the turn is already on the wire |
| `armed(facts)` | gate | decides whether the rule participates at all |

`onModelOutput` receives **normalized** text, reasoning, and the ordered list of tool names the turn called — never raw stream events. The four parsers deliver four different shapes (a Chat Completions `delta`, a Responses API event, an Anthropic frame, a Gemini part); making every rule understand all four would produce rules that silently work on some providers and not others. Each parser knows its own shape, rules see prose.

Because the response has already reached the client, an `injectSystemNote` returned from `onModelOutput` is **queued for the next request** rather than applied. This is what makes shortcut detection actionable: "you claimed the tests pass but called no command this turn" can only be judged once the turn is over.

**Cross-turn state is keyed by the Claude Code session id.** CC sends it nested inside `metadata.user_id`, which is itself a JSON *string*:

```
metadata.user_id = '{"device_id":"073c…","account_uuid":"","session_id":"ce7d…"}'
```

`extractSessionId()` returns only `session_id`. **`device_id` is a stable machine identifier and must never be journalled or uploaded** — it would defeat the journal's entire no-paths design in a single field. Queued corrections live on the engine keyed by session id (not per-model, or two concurrent conversations against the same model would leak into each other), bounded to 64 conversations with oldest-first eviction.

## Reading the system prompt

`BehaviorContext.systemText` and `harness.skills` expose what already arrives on every request: CLAUDE.md, the user's project rules, and the skill listing. A rule reads these to decide a skill or user rule applies, then **injects the relevant content** — it does not tell the model to go and load a skill, for the reason set out above. `extractAvailableSkills()` returns `[]` when no listing is present, which means *unknown*, not "the user has no skills".

## Config

```json
{ "behavior": {
    "rules": {
      "plan-mode/*": "warn",
      "gpt-5.6-*:plan-mode/plan-file-path": "fix"
    },
    "hooks": ["./.claudish/hooks/my-rule.ts"],
    "observer": { "enabled": true, "mode": "suggest" },
    "telemetry": { "enabled": false } } }
```

Rule keys may be **model-scoped** as `modelGlob:ruleId`. Scoped keys beat unscoped ones, and within each tier an exact id beats a glob and a longer glob beats a shorter one. This exists because nothing transfers between models — a rule proven on one is a hypothesis on the next — so a rule can be armed for the model that needs it without arming it everywhere. (`hook:` ids also contain a colon and are deliberately *not* parsed as model-scoped.)

Hooks are user modules exporting `BehaviorRule`s, namespaced `hook:<file>/<id>` so they can never shadow a built-in; load failures warn and skip. The **observer** is a small local model (vision-proxy contract: hard timeout, `null` on failure, never blocks) that sees only a **digest** — tool names, harness facts, the proposed call's argument keys plus path-like values — never conversation text. Its model is **discovered** via `ollama-discovery` (smallest non-embedding), never pinned, and ids outside the rule vocabulary are discarded as hallucinations.

`behavior/observer/corpus.ts` replays recorded CC transcripts offline to build a **labelled** divergence corpus with no live traffic: CC records `toolUseResult.filePath` (the path it actually read) and `plan: null` (whether it found anything), so every replayed session is known-good or known-degraded for free. Over 1129 local transcripts it independently reproduced the diagnosis — 11 degraded, all gpt-5.6-sol, all four Claude models and all three Kimi models clean, and the rule would have caught 11/11.

## Telemetry — the cross-user corpus (v7.35.0+)

The corpus above is one developer's models on one developer's projects. A rule for a model the maintainer never runs needs evidence from someone who does, which is what `POST https://claudish.com/v1/behavior` collects. Contract and intent: `docs/specs/behavior-telemetry-backend.md`; server-side retention is 12 months, then non-identifying weekly aggregates.

**Opt-in, default off**, via `behavior.telemetry.enabled` or `claudish behavior telemetry --enable`. Deliberately NOT sharing `stats.enabled` — that consent was granted for usage statistics, and reusing it for behavioural records would be consent laundering. Local journalling is unaffected and always on.

- **Session aggregates, not decision records.** One payload per session, counters only, so the server never holds a raw per-decision row. Emitted by `telemetry/aggregate.ts` alongside the local journal write at the same call site, so the two can never disagree.
- **Safety is structural, not promised.** `toUploadable()` is an allow-list projection — a field a future contributor adds to the journal cannot leak, it has to be added explicitly. `pathRelation` is the pattern: `same_dir_wrong_name` is the exact discriminator the plan-mode rule keys off and carries no path. Categorical instead of literal, everywhere.
- **`session_id` is a salted SHA-256** (the server rejects a raw CC UUID). The salt is **per-process and never persisted** — strictly stronger than a stored one: no key on disk to steal, and no way for anyone including us to reverse a delivered id. The model id is folded in, so a session routing to several models yields one aggregate per model rather than colliding on an id the server would treat as a duplicate.
- **`context_bucket` is a CLOSED set** (`0-50k` … `200k+`) validated server-side. Adding a value — e.g. splitting `200k+` for 1M-context models — is a spec change, not a client change.
- **Delivery is spool-then-upload, and it has to be.** A session ends when claudish exits, and `process.on("exit")` is SYNCHRONOUS — a `fetch` started there never completes, and blocking shutdown on a round-trip is not an option when the user is waiting on their prompt. So exit does the one thing it reliably can (`appendFileSync` to `~/.claudish/behavior-outbox.jsonl`) and a LATER run drains it in the background. Same trade `stats-buffer.ts` makes, and a hard kill loses nothing.
- **The drain timeout is 15s, not the 3s `/v1/report` uses.** That endpoint is fire-and-forget on the request path where slowness costs the user; this one blocks nothing. Measured against the deployed service: warm ≈600ms, but a **cold start exceeds 3s** — at 3s the first drain after any idle period fails every time and reports only ever land on a second run. Found by running the real client against the real endpoint; the payload was never the problem.
- 429 is **not** honoured by waiting. A background drain must not sit on a 60s timer, and deferring to the next run is the same outcome, later.
