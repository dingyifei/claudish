# Does Claude Code honour a mid-stream `error` event? (measured 2026-09-10)

> Verifies the fix in `openai-responses-sse.ts` for a stream that dies mid tool-call.
> Rationale: `ai-docs/architecture/adapters.md` § "A stream that dies mid tool-call".

## The question

claudish now ends a turn with an SSE `error` event when the upstream socket dies while a
tool call's argument JSON is still streaming. A unit test proves claudish **emits** it. It
cannot prove Claude Code **honours** it.

That distinction is not pedantic. The previous mitigation (v7.12.7, `stop_reason:
"max_tokens"`) shipped on exactly that kind of assumption and was **wrong**: Claude Code
2.1.217 executed a `max_tokens`-terminated `Write` anyway. So the wire signal had to be
measured against a real client, not argued for.

## Answer

**Yes.** Claude Code discards the partial `tool_use` block and retries the turn.

| Build | Truncated `Write` executed? | Transcript markers |
|---|---|---|
| Released **v9.0.8** (buggy) | **YES** | 1 `__unparsedToolInput`, 1 `InputValidationError` |
| Worktree build (fixed) | **no** | 0, 0 |

v9.0.8, reproducing the original production failure in miniature:

```
TOOL_USE Write | stop_reason= end_turn |
  raw='{"file_path":"/tmp/mock-truncation-probe.txt","content":"line one\nline two'

<tool_use_error>InputValidationError: Write was called with input that could not be
parsed as JSON. You sent (first 75 of 75 bytes): {"file_path":"/tmp/mock-truncation-
probe.txt","content":"line one\nline two
```

Both builds retried the turn afterwards and answered normally. The only difference is
that the buggy one ran a tool on 75 bytes of broken JSON first.

## Method

```
Claude Code  ->  claudish (binary under test)  ->  mock upstream (127.0.0.1:8899)
```

`ai-docs/sessions/.../mock-upstream.ts` is a fake Responses API. On the targeted request it
opens a `Write` function_call, emits ONE truncated argument fragment, then destroys the TCP
connection — no `output_item.done`, no `response.completed`. Verified independently with
`curl: (56) Recv failure: Connection reset by peer`.

Run each binary under its own `HOME`, then read that HOME's Claude Code transcript for
`__unparsedToolInput` and `InputValidationError`. The transcript is the authority: it
records the raw bytes the client refused and the real `message.stop_reason`, so the client
side is provable without a claudish `--debug` log.

`OPENAI_CODEX_BASE_URL` only redirects the **API-key** arm. With an OAuth credential
present, `OpenAICodexTransport.getEndpoint()` returns `this.cachedAuth.endpoint` and the
env var is ignored — a run that forgets this silently measures the live backend. A fresh
`HOME` removes `~/.claudish/codex-oauth.json`, which forces the API-key arm.

Flags an unattended claudish run needs today: `-y -q`. See the two design traps below.

## Three traps that produced false results before the real one

**1. A mock that never succeeds punishes correct behaviour.** v1 failed every request.
The fixed build did the right thing — discard, retry — and retried into a wall until the
harness killed it at 5m00s. The buggy build hit the same timeout. Both runs ERRORED
identically and the experiment discriminated nothing. Fix: fail the targeted request
**once**, then serve a complete turn, so a correct client can finish.

**2. Claude Code fires a session-title request CONCURRENTLY with the real turn.**
Truncating "request #1" hit the title generator: the main turn got a clean response 26 ms
later and answered normally, which looks exactly like a pass. Only the per-request log
exposed it — the second request arrived long before the truncated stream had finished
emitting, so it could not have been a retry.

**3. The title request carries the same prompt text**, so a content marker matches both.
They are an order of magnitude apart in size and never overlap (~3.7 KB vs ~88 KB), so the
mock requires marker **and** `length >= 20000` to call a request the main turn.

Trap 1 cost a wrong "inconclusive". Trap 2 nearly produced a false PASS. Both were caught
only because every request is logged with its size and verdict — which is the general
lesson: **instrument the fake, not just the thing under test.**

## Raw evidence

Fixed build:

```
request #1 POST /v1/responses mainTurn=true bytes=88664 -> TRUNCATED+RESET
request #2 POST /v1/responses mainTurn=true bytes=3731  -> COMPLETE
request #1 killing socket after 4 frames
request #3 POST /v1/responses mainTurn=true bytes=89389 -> COMPLETE
=> transcript: 0 __unparsedToolInput, 0 InputValidationError
```

Released v9.0.8:

```
request #1 POST /v1/responses mainTurn=false bytes=3731  -> COMPLETE
request #2 POST /v1/responses mainTurn=true  bytes=88665 -> TRUNCATED+RESET
request #2 killing socket after 4 frames
request #3 POST /v1/responses mainTurn=true  bytes=89627 -> COMPLETE
=> transcript: 1 __unparsedToolInput, 1 InputValidationError
```

## Not covered

The `max_output_tokens` path still reports `stop_reason: "max_tokens"` and its truncated
tool call is still executed by the client. That is deliberate: the truncation there is
deterministic, so an `error` event would make the client retry a request that truncates at
the same byte. Capping the budget is the real fix, and the codex backend rejects
`max_output_tokens` ("Unsupported parameter").
