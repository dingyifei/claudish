# Network recovery, design-Phase 4 — the status flip, measured

> Promoted out of the gitignored session directory deliberately, as
> `network-recovery-phase0-measurements.md`, `-phase2-verification-` and `-phase3-pane-` were.
> CLAUDE.md records three write-ups already lost because they lived in `ai-docs/sessions/`, which
> does not survive a fresh clone or `git worktree remove`.
>
> Session `dev-feature-network-recovery-20260910-110514-0ad0a5a0` · measured 2026-09-11 on
> macOS 25.6.0, bun 1.4.0, magmux 0.11.0, Claude Code 2.1.268. The phase narrative and the per-file
> inventory stay in that session's `implementation-log-phase4.md`; what is here is the evidence.

Phase 4 is the only phase where a mistake costs the user **money** rather than time. At the end of a
tier-1 hold the handler now chooses between a retryable **503** and today's terminal **400**, and
that 503 has to cross `FallbackHandler` without advancing the chain — because advancing off a
`SUBSCRIPTION_PROVIDERS` candidate onto a metered one quotes a real per-token price for a fault that
had nothing to do with any provider.

Suite: **3331 → 3357 pass**, 18 skip, **2 → 2 fail** (the two pre-existing `displayWidth`
Unicode-oracle cases, red on clean main under bun 1.4.0 while CI pins 1.3.10). +26 tests, zero new
failures. `typecheck`, `lint` and `format` exit 0.

---

## 1. C-1 and C-6's second run — one real interactive session

A real `claudish -i --model ollama@qwen2.5:0.5b`, a real Claude Code 2.1.268, a real magmux wrapper,
a real recovery pane, a real `ollama serve` with a real 0.5B model. The only harness is a PTY:
`pty-host.py` allocates one of a known size and execs claudish on the slave side, which is what a
terminal does. macOS `script(1)` cannot be used — it calls `tcgetattr` on its own stdin and dies
when that is a pipe, which it is for every process an agent session spawns.

Fault: ollama stopped, so `127.0.0.1:11434` refuses in ~1 ms. Server restarted **after the handoff**.

### C-1 — the turn does not end

`API Error: 400` never appeared on screen or in the byte stream, polled every 5 s for the whole run.
What appeared instead, at t+61 s, with the session still live:

```
 ▐▛███▛█   Claude Code v2.1.268
▝▜██████▀  ollama@qwen2.5:0.5b with xhigh effort · API Usage Billing
❯ Reply with exactly one word: banana
✶ Wibbling… (57s)
────────────────────────────────────────────────────────────────────────────────
  * ollama@qwen2.5:0.5b | $0.00 | 1s | 󰍛 294M | ░░░░░░ 0% • $0.000 • N/A
────────────────────────────────────────────────────────────────────────────────
  ██ NETWORK · Ollama refused
  Cannot connect to Ollama at http://localhost:11434/v1/models. Make sure the server is running.
  host localhost:11434 · ConnectionRefused · local
  next attempt in 48s · attempt 8 · 57s in recovery
  last: ConnectionRefused · 2 requests held
  click here or Ctrl-G Tab, then [r] try now · [q] give up
```

`2 requests held` is not decoration: Claude Code issues the main-loop request and the small
title/summary request concurrently, both fail within milliseconds, and both are parked on **one**
episode with **one** timer. That is the coordinator's whole reason to exist, visible.

### C-6, second run — the two tiers are ONE episode

The decisive sequence, verbatim from the session's own debug log:

```
13:53:05.646  [Recovery] Ollama exhausted after 12 attempts in 165009ms
              (episode f4d31fb2-…, ui_lease=true) — handing the retry back to the client (503, tier 2)
13:53:05.646  [Recovery] episode f4d31fb2-… handed off after 165009ms, 12 attempts — holding 120s for a client retry
13:53:06.192  [Recovery] Ollama rejoined episode f4d31fb2-… (client retry 1, ladder 5, attempts 12)
13:54:06.285  [Recovery] episode f4d31fb2-… handed off after 225647ms, 16 attempts — holding 120s for a client retry
13:54:08.534  [Recovery] Ollama answered on the client's own retry — closing episode f4d31fb2-… instead of waiting out its grace
```

- Claude Code re-POSTed **546 ms** after the 503 — well inside the measured 38.4 s backoff cap and
  3.1× inside `EPISODE_GRACE_MS`.
- The rejoin carried **the same episode id**, `ladder 5` (not reset to 0) and `attempts 12`. One
  banner, one attempt counter, one episode id across both tiers.
- There were **two** handoffs and three client requests. `distinct episode ids in the whole log: 1`.

And the turn finished, on a model that was not running when it started:

```
❯ Reply with exactly one word: banana
⏺ banana
✻ Cooked for 4m 1s · done 11:54 pm
                                                             28772 tokens
────────────────────────────────────────────────────────────────────────
  * ollama@qwen2.5:0.5b | $0.15 | 4m2s | 󰍛 375M | ░░░░░░ 14% • Ollama • 12% (28k/32k)
────────────────────────────────────────────────────────────────────────
  ██ NETWORK · Ollama recovered
  16 attempts over 4m 02s
  this pane closes on its own
```

| | |
|---|---|
| handoff observed | t+171 s |
| `ollama serve` started | t+191 s — **after** the handoff |
| turn answered | t+246 s |
| upstream 200s after recovery | 2 |
| distinct episode ids | **1** |
| `API Error: 400` ever on screen | **false** |

**Recovery took ~43 s longer than the outage did**, and that is by design: `ladderIndex` is
episode-scoped and does not reset on re-entry, so the rung after the rejoin was 60 s. `[r] try now`
exists for exactly that impatience.

Harness: `phase4/c1-c6-live.ts`. Evidence: `steps.txt`, `timeline.txt`, `C-6-final.txt`,
`recovery-lines.txt`.

---

## 2. C-18 — Tier 2 engages for a SLOW connection failure

The round-2 CRITICAL's regression test, and the only criterion in the file that is not a ~1 ms
loopback refusal. Two runs against **F-SLOW** (`https://192.0.2.1`, TEST-NET-1), with a real magmux
and a real `claudish recovery-pane`.

**Fidelity check first**, because `192.0.2.1` is unrouted by convention and a captive portal can
answer it: measured **75 006 ms**, code `ConnectionRefused`. Phase 0 measured 75 004 ms and Phase 2
measured 75 005 ms on the same machine. ADD-2 confirmed a third time — *slow and fast connect
failures are indistinguishable by code on macOS*, only elapsed time separates them.

### RUN 1 — the pane alive and painting

```
RUN 1 status              : 503
RUN 1 x-should-retry      : true
RUN 1 x-claudish-recovery : 1
RUN 1 body: {"type":"error","error":{"type":"overloaded_error","message":
  "Cannot reach Slow Probe at https://192.0.2.1/v1/chat/completions. Check your network connection.
   claudish retried 5× over 4m 30s without reaching it — still trying, watch the recovery pane."}}
RUN 1 banner still painted at exhaustion : true
RUN 1 dead-proxy notice ever shown       : false
```

The attempts, which is how you confirm the fault really was slow rather than refused — they end at
the **45 s clamp**, not at the ladder's nominal gaps:

| attempt | at | code |
|---|---|---|
| 1 | 13:40:14 | `ConnectionRefused` (unclamped, 75 s) |
| 2 | 13:41:04 | `TimeoutError` — 5 s gap + 45 s clamp |
| 3 | 13:41:59 | `TimeoutError` — 10 s + 45 s |
| 4 | 13:43:14 | `TimeoutError` — 30 s + 45 s |
| 5 | 13:44:44 | `TimeoutError` — 60 s + 45 s |

**The lease, sampled every 10 s for the whole 420-second run**, including deep inside each 45-second
clamped attempt — the exact window in which the superseded frame-renewed lease died with the banner
still painted:

```
[151.4s] lease={"paneOpen":true,"lastAckAgoMs":139,"valid":true} painting=true
[211.4s] lease={"paneOpen":true,"lastAckAgoMs":9,  "valid":true} painting=true
[341.4s] lease={"paneOpen":true,"lastAckAgoMs":143,"valid":true} painting=true
[411.4s] lease={"paneOpen":true,"lastAckAgoMs":105,"valid":true} painting=true
```

`lastAckAgoMs` never exceeded ~210 ms against a `UI_LEASE_MS` of 10 000. The heartbeat is on the
pane's own 1 Hz timer, so it is indifferent to the proxy having nothing to say for 45 seconds. Under
the superseded design this column would have read `valid:false` for most of the run and RUN 1 would
have answered 400.

The screen at the moment of exhaustion, same second as the 503:

```
  ██ NETWORK · Slow Probe refused
  Cannot reach 192.0.2.1 for Slow Probe. This is a network problem on your machine — check your
  internet connection, VPN, or DNS resolver (e.g. Tailscale MagicDNS) — not Slow Probe.
  host 192.0.2.1 · ConnectionRefused
  connecting to 192.0.2.1… · attempt 4 · 4m 30s in recovery
  last: TimeoutError · 1 request held
  click here or Ctrl-G Tab, then [r] try now · [q] give up
```

Two things to read carefully here. The banner says **`refused`** because macOS reports
`ECONNREFUSED` for an unrouted remote address — ADD-2 again, and the *remote* wording
(`Cannot reach … for …`, network/DNS advice) is correct precisely because `isLoopback` decides the
sentence rather than the code. And it says `attempt 4` where the log says 5: the pane is one 1 Hz
tick behind at the instant of capture, which is a render lag and not a state disagreement.

### RUN 2 — the pane closed before exhaustion

```
RUN 2 status              : 400
RUN 2 x-claudish-recovery : (absent)
RUN 2 body: {"type":"error","error":{"type":"connection_error","message":
  "Cannot reach Slow Probe at https://192.0.2.1/v1/chat/completions. Check your network connection."}}
```

Byte-identical to the pre-recovery behaviour, including the `connection_error` type
`probe-live.ts:334` keys off.

Harness: `phase4/c18-live.ts`. Evidence: `steps.txt`, `C-18-run1-lease-samples.txt`,
`C-18-run1-at-exhaustion.txt`, `C-18-recovery-log.txt`.

---

## 3. C-12 — the chain does not advance. THE ONE THAT COSTS MONEY.

A real `Bun.serve` + Hono app, a real `FallbackHandler` over two real `ComposedHandler`s, two really
refused sockets, the real ladder on the **real clock**, a real magmux with a real recovery pane
holding a real lease, and a real HTTP POST — so the status and headers below are the ones a client
actually receives, which also proves they survive `Bun.serve` rather than only existing on the
`Response` object.

**One substitution, and it is forced rather than convenient:** the candidate list is constructed
directly instead of by `route()` on a bare model name. A real bare-name chain resolves to real
vendor endpoints, and taking the network down to those needs privileges this environment does not
have. Everything the criterion is about — the chain, the advance decision, the marker, the log line
— is downstream of routing and runs unchanged.

The deadline was shortened through `API_TIMEOUT_MS=60000`, exactly as a user would shorten it, so
each run takes 15 s rather than 4 minutes. The ladder's gaps are unaffected; only how many fit is.

### Variant A — the ordinary case

```
held for 15.0 s
status: 503   x-should-retry: true   x-claudish-recovery: 1
body: {"error":{"type":"overloaded_error","message":"Cannot connect to Sakana Fugu at
  http://127.0.0.1:64490/v1/chat/completions. Make sure the server is running.
  claudish retried 3× over 15s without reaching it — still trying, watch the recovery pane."}}

[Fallback] … trying next provider   : 0   (MUST be 0)
[Fallback] … falling through (cost) : 0   (MUST be 0)
any mention of candidate B at all   : 0
the line that replaced it           : 1
  [Fallback] Sakana Fugu (subscription) is unreachable and claudish is still retrying it —
  holding the chain here rather than switching providers mid-outage.
VERDICT: PASS
```

### Variant B — the 503 message deliberately contains "quota"

This is the structural guarantee, and a wording-based fix fails it. `isRetryableError`'s FIRST
statement is `hasQuotaExhaustionWording(errorBody)` — status-agnostic by design, because the
transport has already remapped terminal errors to 400 — and its phrase list contains the **bare
substring `"quota"`**. A provider display name of `Quota Cloud` puts that word in the 503's message
for free.

```
variant: quota — candidate 1 display name "Quota Cloud"
status: 503   x-claudish-recovery: 1
body: … "Cannot connect to Quota Cloud at http://127.0.0.1:64995/… claudish retried 3× over 15s …"

message contains "quota"            : true
hasQuotaExhaustionWording(message)  : true   ← THE HAZARD, confirmed on this exact body
[Fallback] … trying next provider   : 0
any mention of candidate B at all   : 0
VERDICT: PASS
```

The hazard is asserted first, on the real body, because a variant that did not actually trip the
phrase list would prove nothing.

Harness: `phase4/c12-live.ts` (`plain` | `quota`). Evidence: `steps.txt`, `C-12-log.txt`.

---

## 4. `exhaustedChainStatus`, decided

A recovery 503 **cannot reach it**, by construction rather than by luck. `errors.push` happens in
exactly three places in `FallbackHandler.handle()`; the verbatim marker return precedes all of them,
and the only other push is the `catch`, which takes a thrown error rather than a `Response`.

Widening `isTransient` to look for the marker would therefore be dead code that reads like a live
guarantee, so nothing was changed there. What pins the property is a test driving the real shape —
candidate 1 failing with a **retryable 401**, candidate 2 answering the marked 503 — and asserting
the client receives 503 with the marker intact rather than the combined terminal 400 that
`exhaustedChainStatus([401, 503])` would have produced. The function's doc comment now names the
trap rather than the fix.

## 5. Forgeability, re-verified at source

Both round-3 facts still hold, checked 2026-09-11:

- every non-ok exit from `ComposedHandler` is `c.json(...)`, which builds headers from nothing; the
  file's single `c.header()` (`X-Dropped-Params`) sits **after** the `!response.ok` early returns;
- the only path that copies upstream headers verbatim — `stream-head-sniffer.ts`'s
  `replayResponse()` — is reached from step 7b, which runs after `!response.ok` has already
  returned, i.e. on a 200. `FallbackHandler` returns an ok response as success before it ever looks
  at the marker.

**The first forgery mutation was itself a finding.** Mutating the `ensureAnthropicErrorFormat` exit
to `return response` SURVIVED — because an upstream **401** does not take that branch. It takes the
terminal-error 400 remap (`wrapAnthropicError(400, surfaced, "invalid_request_error",
response.status)`). A mutation on a branch the path does not execute proves nothing about the path.
Both exits now have a mutation and a test.

## 6. Mutation proof — 17 mutations, 17 killed, 0 survivors

Runner: `phase4/mutate.ts`. Each reverts ONE property, runs the tests that claim to pin it, and
restores **by file copy — never git**: the stash stack and the index are shared with the main
checkout and every sibling worktree.

Killed: the lease gating the 503 · `gave_up` excluded from the 503 arm · the 503 itself ·
`x-should-retry` · the marker header's wire NAME · the recovery clause in the message · **the marker
early return in `isRetryableError`** · **the marker's POSITION relative to the quota phrase match** ·
the verbatim return in `handle()` · the marker's exact VALUE · forgery via the remapped terminal exit ·
forgery via the non-terminal exit · the watchdog being set at all · the watchdog following the UI
switch · the rejoin inside the grace window · closing the handoff on the client's own success ·
closing ONLY a handoff episode.

The two in bold are the billing pair. The second is the one worth naming: the marker check *present
but late* — moved below `hasQuotaExhaustionWording` — is killed only by the C-12 quota variant.
Presence is not the property; **order** is.

Two survivors on the first pass, both real test gaps, both closed:

| survivor | why | what closed it |
|---|---|---|
| the marker header's wire NAME | both sides import the constant, so a rename moves them together and nothing notices | an assertion on the literal `"x-claudish-recovery"`, plus one reading the header off the response with no constant |
| FORGERY | the mutated exit was the wrong branch (§5) | the mutation moved to the branch that executes, plus a second test for the other exit |

---

## 7. Three things found while building, none of them in the plan

### 7.1 A handoff that ends in SUCCESS is not a rejoin, and left the banner lying

The design says the client's re-POST rejoins the episode. That is what happens while the network is
still down. When the network has **come back**, the re-POST's first attempt is `ComposedHandler`'s
byte-identical primary fetch, which runs *before* the coordinator sees the request — so it simply
succeeds. No `catch`, no `joinEpisode`, no rejoin. The episode then sat in `handoff` until its
120-second grace expired, with the pane painting *"waiting for Claude Code to retry"* over a session
that was already working.

That is not cosmetic. The pane's legibility is the entire justification for the retryable status; a
banner that lies about a live outage teaches the user to ignore the next real one.

`noteTargetReachable()` closes a `handoff` episode when any request reaches the same target, guarded
by `episodeCount() > 0` — a `Map.size` read that is 0 on every machine that has never had an outage,
so the healthy path pays one integer comparison. Only `handoff` is closed: an episode in
`attempting`/`waiting` still has parked waiters whose ladder it is, and one request's success says
nothing about another's.

Found by a failing assertion, not by review. Confirmed live in §1 — `13:54:08.534 [Recovery] Ollama
answered on the client's own retry — closing episode … instead of waiting out its grace` — and the
banner flipped to `██ NETWORK · Ollama recovered` in the same second.

### 7.2 `gave_up` must be excluded from the 503 arm, and the lease cannot do it

The exhaustion branch covers both `exhausted` and `gave_up`. Gating the flip on the lease alone
answers a retryable 503 for `[q] give up` — and the pane that took the keystroke is by definition
alive, so the lease IS valid at that instant. Claude Code would re-ask immediately and the give-up
key would become a no-op with the banner still on screen. The guard is `result.kind === "exhausted"
&& leased`; row 9 of the status table stays 400.

### 7.3 The watchdog's side effect has no narrower lever

`CLAUDE_CODE_RETRY_WATCHDOG=1` is global to the child, so it turns the stream-head sniffer's
exhaustion 503 and `exhaustedChainStatus`'s all-transient 503 into ~300-attempt retries too. Neither
opens an episode or a pane, so while the client loops on them the reason is legible **nowhere** —
they degrade to "API error · Retrying" for far longer than before. More retry is the intended remedy
for both, but the visibility argument that earns the recovery 503 its retryable status does not
extend to them. The variable is fixed at spawn and cannot key on whether a banner exists, so this is
the honest price of one process-wide switch rather than something a better gate could avoid.

It is gated on `resolveRecoveryUi()` so surface and reach move together: `--no-recovery-ui` means no
pane, no lease, an inline 400 at exhaustion, nothing handed back — and therefore no reason to extend
the client's budget either.

---

## 8. What is NOT verified, and why

- **C-13's attribution across a handoff.** `retry_attempts` / `recovery_episode_id` are §3.4 stats
  fields and do not exist yet; the 503 arm records a stats event with `http_status: 503` but carries
  no episode id. C-13 is a later phase's criterion.
- **C-19** (a network drop during a *forced auth* retry). The auth sites were fixed in Phase 1 and
  route through the same `recoverConnection`, but the 401-then-drop sequence was not driven live.
- **The watchdog's ~300-attempt reach, end to end.** `retryWatchdogEnv()` is unit-tested and the
  variable is verified to reach the child's env, but observing 300 client attempts would take a day
  of wall clock. The measured facts it rests on are Phase 0's (`~11` attempts without it; the
  `retry-after` honouring; the 38.4 s backoff cap).
- **A bare auto-routing name through `route()`** for C-12 (§3).
