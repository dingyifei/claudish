# The gemini-3.8-flash in-band 400: what is known, what is not, and who owns it

**Date:** 2026-09-17
**Origin:** bug report `claudish-9.4.0-routing-failures.md`, issue 2
**Route:** `or@google/gemini-3.8-flash` (OpenRouter → Google AI Studio)
**Status:** the claudish-side defect is FIXED. The upstream cause is UNATTRIBUTED.

## Short answer to "is this a server-side error?"

**Probably not, and not proven either way.** The evidence points at the shape of
the request claudish sent, not at a server fault, but the one field that would
settle it was redacted out of the log.

There were two separate defects stacked on top of each other, and only the first
was ever claudish's:

1. **claudish silently discarded the error.** Fixed. This is what turned a
   reported failure into `exit 0` with zero output.
2. **Something upstream rejected the request with a 400.** Unattributed. The
   rejection itself is real and predates the fix.

Fixing the first is what makes the second diagnosable at all.

## What is known, verbatim

From `~/.claudish/logs/claudish_2026-09-16_12-52-57.log`:

```
[2026-09-16T12:53:43.218Z] [OpenRouter] Response status: 200
[2026-09-16T12:53:43.218Z] [Streaming] ===== HANDLER STARTED for google/gemini-3.8-flash =====
[2026-09-16T12:54:07.118Z] [SSE:openai] {"id":"<35 chars>","object":"<21 chars>",
  "created":1789563213,"model":"unknown","provider":"Google AI Studio","choices":[],
  "error":{"code":400,"message":"<28 chars>",
           "metadata":{"error_type":"invalid_request","provider_code":"400"}}}
[2026-09-16T12:54:07.118Z] [Streaming] Text-based tool calls found: 0
[2026-09-16T12:54:17.396Z] [OpenRouter] Response status: 200
[2026-09-16T12:54:17.396Z] [Streaming] ===== HANDLER STARTED for google/gemini-3.8-flash =====
[2026-09-16T12:54:41.284Z] [SSE:openai] {... same error frame ...}
[2026-09-16T12:54:41.286Z] [Streaming] Text-based tool calls found: 0
[2026-09-16T12:54:41.695Z] [Claude Code] Exited with code 0
```

Established facts:

- The HTTP status was **200**. The 400 was carried inside the body.
- The rejecting party is named: **Google AI Studio**, fronted by OpenRouter.
- The classification is **`invalid_request`**, not a capacity, quota or
  availability failure.
- It happened **twice**, ~34 seconds apart, on two separate requests. Claude
  Code retried once on its own and got the same answer.
- The same route **succeeded 40 minutes earlier** in the same session, producing
  a complete 19047-byte review.
- Earlier turns in the failing session succeeded and emitted
  `reasoning_details` blocks of type `reasoning.encrypted`, which is how
  OpenRouter conveys Gemini thought signatures.

## What is NOT known

**The error message itself.** The log records `"message":"<28 chars>"`. The
always-on log runs in structural mode, which redacts string bodies and replaces
them with their length. Twenty-eight characters is all we have.

An earlier note in this investigation guessed `Invalid or missing signature`,
which is exactly 28 characters. **That was a guess and should not be repeated as
a finding.** It is consistent with the evidence and with the presence of
encrypted reasoning blocks, and it is not evidence of anything.

## Why `invalid_request` points away from a server fault

A server-side failure — an outage, a capacity limit, a bad deploy — is reported
as 5xx, 429, or an availability error. `invalid_request` with `provider_code:
400` is the upstream saying the payload it received was not acceptable. On this
route the payload is assembled by claudish, so the default assumption has to be
that claudish built something Google would not take.

The intermittency does not contradict that. The request shape changes turn by
turn: a malformed turn only occurs once the conversation reaches the state that
produces it. The same route succeeding 40 minutes earlier tells us the route and
credentials are fine, not that the request is.

## Leading hypothesis, clearly labelled as such

**Gemini thought-signature replay.** Gemini 3.x requires the reasoning blocks
from a previous assistant turn to be echoed back on the next request. OpenRouter
carries them as `reasoning_details` with `type: "reasoning.encrypted"`, and
claudish has `middleware/gemini-thought-signature.ts` whose entire purpose is to
cache and re-inject them. The failing session was emitting exactly those blocks
before it broke.

If that replay is incomplete or mismatched, Google rejects the turn as
malformed, which would produce this error class, on some turns and not others.

**This is a hypothesis. It has not been tested.**

### A lead that was withdrawn

An earlier pass noted that no `[Gemini]` middleware lines appeared anywhere in
the failing session's log, and offered it as possible evidence that the
middleware never ran. **That is not evidence and the lead is withdrawn.**
`logger.ts:isStructuralLogWorthy()` lists the prefixes that reach the always-on
log, and `[Gemini]` is not among them — those lines require `--debug`. Their
absence from a non-debug log is expected and means nothing.

Two independent things had to be ruled out before that could be said cleanly:
the log in question was also being overwritten by sibling processes (see below),
so it was unreliable on its own terms.

## What reproduction attempted, and did not show

2026-09-17, against the current build, `or@google/gemini-3.8-flash`, a
deliberately multi-turn tool-using prompt (`ls`, then read a file, then `wc -l`,
each as a separate tool call):

```
EXIT=0
5 upstream responses, all 200
reasoning_details present in the stream
no error frame
```

The failure did **not** reproduce in one attempt. That is consistent with the
original report calling it intermittent, and it means the hypothesis above
remains untested rather than refuted.

## What was fixed on the claudish side

**The error is no longer discarded.** `openai-sse.ts` read only
`chunk.choices[0].delta` and `chunk.choices[0].finish_reason`. An error frame
carries an EMPTY `choices` array, so every one of those reads returned undefined
and the frame matched nothing at all. It was dropped with no log line, the
stream ended with no content and no `finish_reason`, and the turn was
indistinguishable from a model that had nothing to say.

`describeInStreamError()` now detects the frame and `finalize("error", …)` emits
an SSE `error` event, which is the only signal Claude Code surfaces. Verified by
replaying the real frame sequence:

```
error frame only        → message_start, ping, error
content, then error     → …, content_block_stop, error      (content preserved)
healthy stream          → …, message_delta, message_stop    (unaffected)
```

The rendered message names the responsible party rather than the aggregator:

```
[Google AI Studio] 400 invalid_request Invalid or missing signature
```

**This is also what will settle the attribution.** The new line begins
`[Streaming] Upstream error inside a 200 stream:` and contains the word
`error`, so it passes `isStructuralLogWorthy()` and is written to the always-on
log with the message text intact. The next occurrence records the real 28
characters with no `--debug` flag needed.

**Log collisions are fixed too.** Log filenames were
`claudish_<timestamp>.log` at one-second resolution, opened with
`writeFileSync`, which truncates. `team` spawns its children together, so all
three of that run's slots computed the same path and overwrote each other —
which is why the original log holds three `Server started` lines on three ports
but no handler-creation lines for the gemini child, the very child under
investigation. Filenames now carry the PID.

## How to settle it

In order, cheapest first:

1. **Wait for a recurrence.** The message is now captured automatically. One
   line in the always-on log ends the guessing. This costs nothing.
2. **Re-run the original workload** — the same `team` review, same input, same
   three models. The failure appeared twice in one session, so the conversation
   state that triggers it is reachable.
3. **If it recurs, run that case with `--debug`.** That turns on the `[Gemini]`
   lines, which state whether `reasoning_details` were cached and re-injected,
   and how many blocks were carried. That confirms or kills the hypothesis
   directly.

Only if the message turns out to describe something claudish does not control
does this become a report for OpenRouter or Google. On the evidence available
today it should not be sent to either.

## One thing worth keeping from the original report

The reporter's reading was that content had been generated and lost:

> The billing is the tell: 2.9k output tokens were generated and charged, and
> zero bytes reached stdout. The model produced content.

The instinct was right and the conclusion was not. Those tokens were spent on
the earlier tool-calling turns, which succeeded. The final turn produced an
error, not an answer. What claudish lost was the error, not the content. The
distinction matters because it is what moved the fix from the stream reader's
text handling to its error handling.
