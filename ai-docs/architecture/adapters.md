> FormatConverter / ModelTranslator / ProviderTransport, stream-parser selection, and errors that ride an HTTP 200.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Three-Layer Adapter Architecture (v5.14.0+)

The translation pipeline has three decoupled layers:

## Layer 1: FormatConverter — wire format translation
Translates between Claude API format and target model's wire format (messages, tools, payload).
Each converter declares its stream format via `getStreamFormat()`.
- **Interface**: `adapters/format-converter.ts`
- **Implementations**: OpenAIAdapter, AnthropicPassthroughAdapter, GeminiAdapter, CodexAdapter, OllamaCloudAdapter, LiteLLMAdapter
- **Message/tool conversion**: `handlers/shared/format/openai-messages.ts`, `openai-tools.ts`

## Layer 2: ModelTranslator — model dialect translation
Translates model-specific dialect differences (context windows, thinking→reasoning_effort, vision rules).
- **Interface**: `adapters/model-translator.ts`
- **Implementations**: GLMAdapter, GrokAdapter, MiniMaxAdapter, DeepSeekAdapter, QwenAdapter, CodexAdapter
- **Selection**: `AdapterManager` auto-selects based on model ID

## Layer 3: ProviderTransport — HTTP transport
Handles auth, endpoints, headers, rate limiting. Optionally overrides stream format for aggregators.
- **Interface**: `providers/transport/types.ts`
- **Stream format override**: LiteLLM and OpenRouter implement `overrideStreamFormat()` → `"openai-sse"`

## Composition in ComposedHandler
```
ComposedHandler = FormatConverter (explicit adapter) + ModelTranslator (auto-selected) + ProviderTransport
```

**Stream parser selection** (3-tier priority):
```typescript
transport.overrideStreamFormat() ?? modelAdapter.getStreamFormat() ?? providerAdapter.getStreamFormat()
```

**Adding a new provider**: Add one entry to `PROVIDER_PROFILES` table in `providers/provider-profiles.ts`.
**Adding a new model**: Create a ModelTranslator adapter, register in `adapters/adapter-manager.ts`.
**Verifying wiring**: `claudish --probe <model>` shows the full adapter composition.

## Stream Parsers
Located in `handlers/shared/stream-parsers/`:
- `openai-sse.ts` — OpenAI SSE → Claude SSE (used by most providers)
- `anthropic-sse.ts` — Anthropic SSE passthrough (MiniMax, Kimi direct)
- `gemini-sse.ts` — Gemini SSE → Claude SSE
- `ollama-jsonl.ts` — Ollama JSONL → Claude SSE
- `openai-responses-sse.ts` — OpenAI Responses API → Claude SSE (Codex)

## Gemini tool schemas are protobuf, not JSON Schema (`handlers/shared/gemini-schema.ts`)

`convertToolsToGemini` serves BOTH the Gemini direct-API handler and the Antigravity
OAuth handler, through the single call site `adapters/gemini-api-format.ts`. A bug here
takes out both providers at once, on the first request that carries tools.

Gemini validates the request against a protobuf message, so its errors name proto
fields, not JSON Schema keywords. Every node with `type: "array"` MUST carry `items`;
an absent one is a missing field, not an omitted optional. The failure looks like this,
and it names a path the caller never wrote:

```
400 * GenerateContentRequest.tools[0].function_declarations[1]
  .parameters.properties[query].properties[where].items.items: missing field.
```

`sanitizeSchemaForGemini` copies an ALLOWLIST of keywords and silently drops the rest.
That is what makes this class of bug recur: a tool ships a keyword the allowlist has
never heard of, the element description vanishes, and a bare `{ type: "array" }` goes
out. Two shapes did it before v9.0.3:

- a tuple written with `prefixItems` (JSON Schema 2020-12, e.g. the `Artifact` tool's
  `query.where`), which the allowlist did not carry;
- a bare `{ type: "array" }` that never described its elements at all.

The `Artifact` case was nested, which is why it survived review: the OUTER `items`
existed, so the sanitizer recursed happily, and only the inner node came out bare.

Two defences, and the second is the load-bearing one:

1. `tupleElementSchema` handles both tuple spellings — 2020-12 `prefixItems` and
   draft-07 `items: [...]`.
2. A closing invariant: an array that still has no `items` gets `{ type: "string" }`.
   This holds at every depth and kills the class, not the two known shapes. Keep it
   even when a specific keyword gets handled — the next unknown keyword is the point.

## The stale comment cost more than the 400

The same function stripped `anyOf`, `oneOf`, `minItems`, `maxItems`, `format` and
`nullable`, under a comment asserting Gemini supports none of them. That comment
predates v7.36.0, which repointed `gemini-*` from the retired Code Assist backend
to Antigravity. Nobody re-measured it.

Measured 2026-09-03 against the live backend — full table in
`ai-docs/reports/gemini-tool-schema-support-20260903.md`. **`anyOf`, `oneOf`,
`minItems`, `maxItems`, `enum` and `nullable` are all accepted.** Only `allOf` and
`format` are still stripped, the latter because its per-type allowlist is narrow
enough that a tool shipping `format: "uri"` is a live 400 risk.

Stripping was never free. `normalizeType(undefined)` answers `"string"`, so a
property declared as a union came out `{ type: "string" }` — the model was told to
quote its numbers. A tuple is therefore NOT collapsed to one type; it becomes the
UNION of its position schemas:

```
where: [field, operator, value]        # value is `{}` — any type

  ->  { type: "array", maxItems: 10,
        items: { type: "array",
                 items: { anyOf: [ {type:"string"},
                                   {type:"string", enum:["eq","ne", ...]},
                                   {type:"number"}, {type:"boolean"} ] },
                 description: "Ordered 3-element array: [string, string (one of: \"eq\", ...), any]." } }
```

A union is WIDER than a tuple and never rejects a valid call. The old collapse was
not wider, it was WRONG: it rejected the numbers and booleans the other positions
accept. `{}` — JSON Schema for "any value" — is the case that matters, because
`normalizeType` silently reads it as string.

**Positional binding is the one thing that cannot survive.** Gemini validates every
element against ONE `items` schema, so "position 1 must be one of these operators"
is unsayable. Measured live: with the enum as a bare union branch, the model
answered `">"` and `"=="` instead of `gt` and `eq` — valid, because a free string is
also a branch. `describeTuple` therefore writes the arity, the order AND the
per-position enum values into the `description`, which is free-form and cannot
wrongly reject anything. With that in place the same prompt produced `gt` and `eq`.

## Validation is a live A/B, not a unit test

A unit test here asserts on a payload claudish itself built, so it cannot see this
bug class at all. The evidence is six real interactive `ag@gemini-3.6-flash-high`
sessions — three per build, fresh session each, identical prompt, an MCP tool whose
parameter is a `prefixItems` tuple. Full method and raw records in
`ai-docs/reports/gemini-tool-schema-support-20260903.md`.

| Build | Operator produced | Value type |
|---|---|---|
| pre-fix | no tool call — `400 ... function_declarations[1] ... properties[where].items.items: missing field` | — |
| collapse to one type | `>`/`==`, `>`/`==`, `>`/`=` — 0 of 3 from the schema | `number` |
| union + description | `gt`/`eq` — 3 of 3 from the schema | `number` |

Declaration `[1]` is Claude Code's own `Artifact` tool, the same index users hit, so
the failure is not synthetic and not confined to MCP tools.

**The declared element type is not enforced.** `500` arrived as a JSON `number` on
both accepted builds, including the one declaring `string`. Do not claim the union
"keeps the number a number" — it was never at risk. What the narrow declaration
costs is the vocabulary the model reads: given only a union, the model invented a
symbolic operator in every run, and inconsistently. The description is what moved
that to 3/3.

## Text-based tool recovery is a fallback, and it is load-bearing on the busiest wire

`openai-sse.ts` calls `extractToolCallsFromText` (`handlers/shared/tool-call-recovery.ts`)
at finalization. That function scrapes tool calls out of assistant PROSE, for local models
that cannot emit structured `tool_calls` at all. It is the only production caller, so this
path is exactly the `openai-sse` roster: GLM, Kimi, Grok, DeepSeek, Qwen, OpenRouter, LiteLLM.

Three properties are not obvious from the source and each one shipped as a defect
(v7.68.0, `ai-docs/reports/grok-tool-name-mangling-20260827.md`):

1. **It must not run when the model already emitted a structured call.** Recovery can only
   ADD calls, never repair one. Ungated, a turn holding one real call plus prose mentioning
   a function tag dispatched TWO `tool_use` blocks. The gate is `state.tools.size > 0`.
2. **Every pattern needs the allowlist, not just the last one.** The function stacks six
   patterns; only Pattern 5 (natural language) had a `knownTools` guard, and its `continue`
   reads like a function-wide filter. Patterns 0–4 had none. The allowlist is now the
   request's own advertised tool list, applied to the return value of all six.
3. **A tool name is an identifier, and nothing else may occupy that slot.** Pattern 0 matched
   `<function=([^>]+)>`, which accepts every character except `>`. A `<function=` opened in
   prose swallowed everything up to the next `>`, so parameter names and ARGUMENT VALUES
   became the tool name. `TOOL_NAME_SHAPE` (`adapters/tool-name-utils.ts`) is the one
   definition; `hasExtractableFunctionTag` exists so the parser's text hold-back test cannot
   drift from what the extractor accepts. Drift there withheld text that nothing later emitted.

`TokenTracker.recordToolUse` re-checks the shape and buckets a failure under `malformed`.
The map is written to `stats/*.json` and printed in the session summary, neither of which is
redacted, so a swallowed argument value must never reach it.

**Observation and dispatch are the same event.** `onToolCallObserved` is hooked inside
`send()`, the single frame writer (`openai-sse.ts`), not at the `content_block_start` sites.
That makes "a tool name was only mis-REPORTED" impossible: anything counted in the stats was
also dispatched to Claude Code.

## Errors that ride an HTTP 200 stream (`stream-head-sniffer.ts`)

The Codex backend (`chatgpt.com/backend-api/codex/responses`) reports capacity faults **inside** a 200 body, not via the status code:

```
200 OK
data: {"type":"response.created", ...}
data: {"type":"response.in_progress", ...}
data: {"type":"error","error":{"code":"server_is_overloaded", ...},"sequence_number":2}
```

Every retry hook in claudish keys off the HTTP **status** (`anthropic-compat.ts`'s 429 loop, `antigravity.ts`'s 429 classifier), so this class of failure bypassed all of them. The parser turned it into an assistant **text block** with `stop_reason: "end_turn"` and `onApiError` only flagged stats — so a transient, textbook-retryable fault became a permanent, successful-looking answer reading `[API Error: server_is_overloaded]`.

`sniffResponsesStreamHead()` peeks at the stream head in `composed-handler.ts` step **7b**, which is the only window where the status code is still ours to choose (once Hono flushes the 200, a 503 is no longer expressible):

- **Retryable** (`server_is_overloaded`, `server_error`, `service_unavailable_error`, prose "overloaded"/"try again later") → re-issue upstream with **progressive** backoff `3s → 15s → 30s` (`STREAM_RETRY_DELAYS_MS`). Progressive, not tight: the outage that motivated this ran ~6.5 minutes, so only the late attempts recover anything.
- **All retries exhausted** → HTTP **503** `overloaded_error`. Safe specifically because `fallback-handler.ts`'s `isRetryableError` does NOT list 503 — it cannot silently switch the user off a pinned model, it reaches Claude Code, which runs its own retry loop.
- **Terminal** in-stream errors (`context_length_exceeded`, `invalid_request_error`) are NOT retried — they keep the existing inline-text treatment, which is the actionable path for them.
- **Anything else** (any content event) → `clean`, and the consumed bytes are **replayed byte-identically** so the real parser sees an unchanged stream.

This is the one place the 400-not-503 doctrine (`composed-handler.ts` ~line 461) is deliberately inverted. That rule exists because a 503 makes Claude Code show "API error · Retrying · attempt N/10" with the real reason buried — correct for **terminal** faults, where retrying is theatre. An upstream overload is the opposite: genuinely transient, and the retry banner is the appropriate behaviour because retrying is the actual remedy. Terminal → 400 inline; transient-after-our-own-retries → 503.

**Trade-off to know:** sniffing withholds response headers until the first decisive event, capped by `DEFAULT_SNIFF_BUDGET_MS` (12s, chosen above the 0.85s–7.7s error latencies observed in the real log). On a healthy xhigh-reasoning turn that delays `message_start` by however long the model thinks before its first output item. No content is lost or reordered — the client shows a spinner either way — but time-to-first-byte is genuinely later than before. Past the budget claudish flushes and degrades gracefully to the inline-text path.

`latency_ms` for a retried turn includes the backoff waits by design: the honest figure is time-to-usable-response.

## The remap has a downstream reader: `upstream_status` (v7.62.0, #148)

The 400-not-503 remap is right for the CLIENT and wrong for anything downstream that
still has a decision to make from the status. `FallbackHandler.isRetryableError`
is exactly that: every candidate in a chain IS a `ComposedHandler`, so by the time
the fallback inspects a response the 401/403/terminal-429 has already become a 400.
It fell into the model-not-found branch, matched none of its phrases, and **stopped
the chain at the first provider** — inverting the intent exactly, since "terminal"
means *this* provider will not recover on retry, which is precisely when the next
one should be tried. The errors that most warrant a fallback were the only ones that
could no longer trigger one.

The true status was already on the wire as `error.upstream_status`, attached at the
single remap site. `extractUpstreamStatus` is shared from `anthropic-error.ts` now
rather than living as a private copy in `probe-live.ts`, because two private readers
of one wire field is how they drift.

Three properties keep this safe:

- **Strictly ADDITIVE.** It only turns a `false` into a `true`, and only for
  401/403/402/429. A remapped 400 carrying an upstream 400 falls through to the
  unchanged branches, so nothing that used to surface can now be swallowed by a
  chain advance.
- **A pinned single provider cannot be affected at all.** `proxy-server.ts` builds
  `candidates.length > 1 ? new FallbackHandler(candidates) : candidates[0].handler`,
  so an explicit `provider@model` spec resolves to one candidate and never
  constructs a `FallbackHandler`. There is no chain to advance along, which is what
  makes "could this silently move someone onto per-token billing?" answerable with
  *structurally no* rather than with a heuristic.
- **The quota half was already fixed** by `hasQuotaExhaustionWording` in v7.40.0,
  which is wording-based precisely because the status has been remapped by then.
  This closes the auth half: a revoked or rotated key, where the wording check has
  nothing to match on.

### "Out of credit" and "plan limit reached" are two different facts

`quota-exhaustion.ts` holds two phrase families, not one list. `BALANCE_PHRASES`
means the account cannot be billed and the remedy is to pay; `PLAN_LIMIT_PHRASES`
means a flat-rate allowance is spent and the remedy is to wait or upgrade.
`EXHAUSTION_PHRASES` is their union, so `hasQuotaExhaustionWording` and every
caller of it behave exactly as before — the split only adds
`hasPlanLimitWording`, which `probe-live.ts` uses to choose between the
`out-of-credit` and `plan-limit` probe states.

Balance wins ties: a body carrying both families is a payment problem with plan
wording next to it, and "pay" is the safer of the two instructions to give.

Two live 429s, measured the same afternoon, are why the distinction exists:

| Provider | Body | State |
|---|---|---|
| MiniMax Coding | `Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)` | `plan-limit` |
| GLM (metered) | `Insufficient balance or no resource package. Please recharge.` | `out-of-credit` |

Both rendered as `out of credit` before. For a flat-rate subscriber that is
actively misleading — it sends someone to a billing page to fix a plan that is
working and resets on its own.

The provider's own sentence is the diagnosis, so it must survive to the screen.
`extractErrorMessage`'s cap is therefore sized for the WIDEST consumer (400
chars), not the narrowest: every consumer already bounds itself — the probe row
clips to its column, the TUI detail panel wraps to 2 lines, and
`probe-results-printer` word-wraps to `MAX_ERROR_LINES`. At its old 160 the cap
was no longer protecting a layout, only deleting the remedy from the end of the
MiniMax sentence.

**`exhaustedChainStatus` had the same defect, and fixing the first one exposed it.**
It read `e.status` to decide whether a whole chain failed transiently, and by then
the remap may have rewritten that to 400 — so it was asking a number that no longer
says. The wording check covered the common case *by accident* (a spent plan says so
in words that survive the remap), while a bare `Too Many Requests` came out as a
terminal 400 where Claude Code's retry loop was the actual remedy. It only became
reachable because `isRetryableError` now advances the chain: before, a remapped 429
with no quota wording stopped at candidate 1 and exhaustion was never reached. Both
now recover `upstream_status`, scoped to 429/503 — exactly the set already treated
as transient for un-remapped statuses, so the rule became independent of whether a
remap happened rather than gaining a new special case.

The general lesson: **any code that branches on an HTTP status downstream of the
remap is suspect.** Grep for `status ===` under `handlers/` before assuming a new
one is safe.

## The catalog's endpoint contract has two halves (v9.0.7)

`gpt-6-astra` was in the catalog and could not run. The child exited 1 on

```
400 unknown_parameter — "Unknown parameter: 'max_output_tokens'."
```

`max_output_tokens` is not a wrong parameter. It is the RESPONSES spelling, and
the catalog says so in the same record that names it:

```json
{ "modelId": "gpt-6-astra",
  "endpoints": { "openai": { "api": "responses",
                             "toolsWithReasoning": "requires-responses" } },
  "tokenParam": "max_output_tokens" }
```

claudish read `tokenParam` (in `OpenAIAPIFormat.tokenParamName`) and ignored
`endpoints.openai.api`. `lookupModelEndpoint` had been written for that field
and had **never had a caller**. So the request carried the Responses parameter
name to the Chat Completions endpoint.

Reading one half is worse than reading neither. Had the gate ignored
`tokenParam` too, the name rule would have guessed `max_tokens` and the request
would have been merely suboptimal instead of rejected. A parameter name is only
meaningful against the API it belongs to, so the two fields must be read
together or not at all.

**Why the name rule could not survive.** `requiresResponsesApi` decided the wire
API from `/^gpt-5\.6/ || includes("codex")`. `gpt-6-astra` shipped 2026-09-03
and matches neither. This is the failure mode CLAUDE.md names — *a default is a
rule, never a pinned id* — arriving on a schedule nobody controls: the rule was
correct when written and was falsified by a release. The gate now reads the
catalog first and keeps the name rule as the cold-cache fallback, the same
catalog-first shape `tokenParamName` already used for the sibling question.

**The catalog may only WIDEN that gate, never narrow it.**
`OpenAIProviderTransport.getEndpoint()` independently forces `/v1/responses` for
any name containing `codex`. A catalog record that said "chat completions" for
such an id would put an `OpenAIAPIFormat` body on a Responses endpoint — the
same format/endpoint split the Zen Go MiniMax bug produced, in the other
direction. The name rule therefore stays an unconditional `||`.

### A hint that infers must not outrank a body that states

The same 400 was rendered as:

```
Input too large. Reduce message history or use a larger-context model.
```

for a 6.7 KB prompt against a 1.05M window. `getRecoveryHint`'s 400 branch
detects an oversized prompt with `lower.includes("token")`, and OpenAI's
parameter NAMES contain that word — `max_output_tokens`,
`max_completion_tokens`. So a parameter rejection matched the size test and the
advice contradicted the body printed beside it on the same line. A reader
following it would shrink a prompt that was never the problem.

`isRequestShapeError` (`handlers/shared/request-shape.ts`) now runs first and
reads the provider's own `code`. It is deliberately narrow: a genuine overflow
names a LENGTH, not a parameter (`context_length_exceeded`, "maximum context
length is N tokens"), so widening the predicate is how the size hint — which
still has to work — gets broken.

This is the third entry in this file where a heuristic talked over a provider
that had already stated the fact, after `RegionError`'s link and MiniMax's plan
wording. The general lesson: **when the provider ships a structured `code`,
branch on it before pattern-matching its prose.** Prose heuristics are for
providers that give you nothing else.

Note the status here is safe to branch on: `getRecoveryHint` is called with the
raw `response.status` at the upstream error site, upstream of the remap
described above.
