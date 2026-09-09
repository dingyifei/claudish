# What the Antigravity/Gemini validator actually accepts in a tool schema

Measured 2026-09-03 against the live backend, one Google AI Ultra account,
project `aicode-consumers`, tier `g1-ultra-tier`, model `gemini-3.6-flash-high`,
host `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`.

Probe: `ai-docs/sessions/dev-debug-quickfix-gemini-tuple-items-20260903-203717-b6dc44/probe-schema-support.ts`
(session dirs are gitignored; the script is reproduced in full at the end).

Every variant sends the SAME tool, differing only in one property's schema.

## Why this was measured

`sanitizeSchemaForGemini` strips `anyOf`/`oneOf`/`allOf`, `format`, `nullable`,
and every numeric or length constraint, under a source comment asserting Gemini
does not support them. That comment predates v7.36.0, which repointed `gemini-*`
from the retired Code Assist backend to Antigravity. Nobody had re-measured it.

Stripping is not free. A property declared as a union lost ALL type information
and came out `{ type: "string" }`, because `normalizeType(undefined)` defaults to
string. The model was then told to send a string where the tool wanted a number.

## Result

| Variant | Status | Verdict |
|---|---|---|
| `control-original-bug` — nested array, inner has no `items` | **400** | control fired; probe reaches the validator |
| `current-fix-string-items` — collapse to `{type:"string"}` | 200 | accepted, but narrows the type |
| `anyof-inside-items` — `items: {anyOf:[...]}`, no sibling `type` | 200 | **unions ARE supported** |
| `anyof-with-sibling-type` — `type` and `anyOf` together | 200 | accepted |
| `anyof-top-level-property` — union on the property itself | 200 | accepted |
| `min-max-items` — `minItems`/`maxItems` | 200 | accepted |
| `raw-prefixitems` — send `prefixItems` untouched | **400** | ignored as unknown, then `items` reported missing |
| `enum-inside-items` | 200 | accepted |
| `format-and-numeric-constraints` — `format:"int32"`, `minimum`, `maximum` | 200 | accepted |
| `nullable-field` | 200 | accepted |

The control's message is character-for-character the one users hit:

```
* GenerateContentRequest.tools[0].function_declarations[0]
  .parameters.properties[where].items.items: missing field.
```

## What this changes

1. **A tuple no longer has to collapse to `string`.** The honest translation of
   `[field, operator, value]` is a UNION of the position schemas, so the schema
   states something true about every position instead of about the first one.
2. **`prefixItems` is not merely unsupported, it is invisible.** Gemini does not
   reject the unknown keyword; it ignores it and then complains that `items` is
   missing. That is why the error names a field the caller never wrote.
3. **`minItems`/`maxItems` are real.** Dropping them let the model emit arrays the
   tool would reject downstream.

## What is still inexpressible

Positional binding. Gemini validates every element against ONE `items` schema, so
"position 1 must be one of these operators" cannot be stated. A union permits the
operator enum at every position, which is wider than the truth but never rejects a
valid call. claudish compensates by appending the arity and order to the schema
`description`, which is free-form and cannot wrongly reject anything.

## Not measured, deliberately

`format` was probed only with `int32`. Gemini documents a narrow per-type
allowlist (`enum`/`date-time` for string; `float`/`double`/`int32`/`int64` for
number). A tool shipping `format: "uri"` may well 400, so claudish still strips
`format`. Same for `allOf`: an intersection has no Gemini equivalent.

## Live A/B: 3 interactive sessions per build

A 200 proves the schema was accepted. It does not prove the model can use it. So
the conversion was measured end-to-end, in real interactive sessions, not by unit
test — a unit test only asserts on a payload claudish itself built.

**Setup.** One MCP server exposing a single tool whose `where` parameter is an
array of `prefixItems` tuples `[string, string(enum), {}]`. The tool does no work:
it appends every received value plus its RUNTIME JSON TYPE to a file. Recording to
a file rather than scraping the terminal is deliberate — see "Two measurement bugs"
below. Fresh interactive session per run, `ag@gemini-3.6-flash-high`, Claude Code
v2.1.259, identical prompt. Harness:
`ai-docs/sessions/dev-debug-quickfix-gemini-tuple-items-20260903-203717-b6dc44/live/`.

Prompt: *"Call the query_rows tool once on collection "orders" with two where
clauses: cost greater than 500, and status equals shipped."*

**Result — 6 sessions, 0 errors.**

| Build | Operator the model produced | Value type |
|---|---|---|
| pre-fix (`6c5800b^`) | never reached a tool call: `400 ... function_declarations[1] ... properties[where].items.items: missing field` | — |
| collapse to one scalar type | `>`/`==`, `>`/`==`, `>`/`=` — **0 of 3 from the schema** | `number` |
| union + arity/enum in description | `gt`/`eq`, `gt`/`eq`, `gt`/`eq` — **3 of 3 from the schema** | `number` |

### What that establishes

1. **The pre-fix 400 names `function_declarations[1]`, Claude Code's own `Artifact`
   tool** — the exact index users reported, alongside `[33]`, the probe tool. Both
   failed in one request. The bug is not synthetic and not confined to MCP tools:
   any harness tool carrying a tuple triggers it.
2. **The declared element type is NOT enforced.** `500` came back a JSON `number`
   on BOTH accepted builds, including the one whose schema said `string`. An
   earlier draft of this report claimed the collapse forced `"500"`; that was
   wrong and is retracted. The cost of a narrow declaration is not rejection.
3. **The cost is the vocabulary the model reads.** Given only a union, the model
   invented a symbolic operator every time, and inconsistently — `==` twice, `=`
   once — because a union permits the enum branch at every position and therefore
   states nothing about which position it belongs to. Writing the arity, order and
   per-position enum values into the `description` moved it to 3/3 correct. That is
   why `describeTuple` spells out the values instead of just the types.

### Two measurement bugs, both of which produced SILENCE

Recorded because each looked exactly like "the model ignored the tool", and the
first set of six runs was discarded because of them:

1. The `export` of the record path was typed into a zsh that had not finished
   starting, so it was lost. Six successful tool calls left no trace.
2. Sending the prompt text and `Enter` in one `tmux send-keys` burst made Claude
   Code's TUI read it as a PASTE. The text sat in the input box, unsubmitted,
   forever. Type, pause, then send `Enter` separately.

A run that produces no output is indistinguishable from a run that failed. Dump
the screen on timeout; it is the only thing that can tell them apart.
