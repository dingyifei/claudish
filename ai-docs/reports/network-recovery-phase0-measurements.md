# Phase 0 — measurements

Five empirical unknowns the design could not resolve under plan mode, plus one source claim — and
U-4 as a bonus, because it runs on the same stub as U-2 and costs a minute.
Everything here was run on this machine, on this date. Scripts sit beside this file; raw output is
in the `*-result.json` / `*-raw.log` files each script names.

**Machine:** darwin 25.6.0, arm64 · **Bun** 1.4.0 (`34cbb9a4`) · **Claude Code** 2.1.267 ·
**magmux** 0.11.0 (`8ce5ef8`) · **Hono** ^4.10.6 · shell `/bin/zsh`
**Date:** 2026-09-10

| # | Question | Verdict | Number |
|---|---|---|---|
| U-3 | Does `Request.signal` abort on client disconnect? | **RESOLVED TRUE** | 0.49–0.86 ms from kill to listener |
| U-1 | Is `server.timeout(req, 0)` reachable and effective? | **RESOLVED TRUE** | survives 6× the idle timeout |
| U-2 | Where does Claude Code's abort land? | **RESOLVED TRUE** | **359.6 s** — `API_TIMEOUT_MS`'s 360 s default |
| F-SLOW | Does `192.0.2.1` hang? | **RESOLVED TRUE** | 75.004 s, then `ECONNREFUSED` |
| U-5 | magmux launch overhead | **RESOLVED TRUE** | +107 ms median (magmux + login shell) |
| U-4 *(bonus)* | Claude Code's retry gaps on a 503 | **RESOLVED** | backoff caps at **38.4 s**; budget ~11 attempts / ~174 s |
| claim | `getHeaders()` outside every `try`, network for `gk@` | **HOLDS** | `composed-handler.ts:592`, `grok-credentials.ts:481` |

---

## U-3 — BLOCKING. Does Bun's `Request.signal` abort on client disconnect?

### Method

`u3-signal-abort.ts` — a `Bun.serve` with `idleTimeout: 0` (so Bun's own idle timer cannot
confound the result) that logs `signal.aborted` at handler entry and installs an abort listener.
Two request shapes × three disconnect flavours:

- **held** — the handler has *not* returned a `Response`; it is `await`ing. This is §5.4's retry
  ladder: headers were never sent. **This is the shape the design depends on.**
- **streaming** — the handler returned a `Response` whose body is an open `ReadableStream`.
  Headers went out; the body never completes.
- Killed by: `curl` + SIGINT (Ctrl-C), `curl` + SIGKILL, and an in-process `fetch` +
  `AbortController`.

`u3b-latency-and-hono.ts` — refinement, because the first script measured from *handler entry*, so
its number was dominated by the 1500 ms we waited before killing. This one timestamps the **kill
instant** and differences against the listener. It also repeats everything through **Hono mounted on
`Bun.serve`**, which is claudish's real shape (`proxy-server.ts:1137`,
`Bun.serve({ fetch: app.fetch, … })`), and checks the two properties §5.4 needs beyond "it fires".

### Raw output

`u3-result.json` — 6/6 fired:

| shape | kill | `aborted` at entry | listener fired | `stream.cancel()` also fired |
|---|---|---|---|---|
| held | SIGINT | false | **yes** | — |
| held | SIGKILL | false | **yes** | — |
| held | fetch-abort | false | **yes** | — |
| streaming | SIGINT | false | **yes** | yes |
| streaming | SIGKILL | false | **yes** | yes |
| streaming | fetch-abort | false | **yes** | yes |

`u3b-result.json` — kill-instant → listener latency:

| stack | shape | kill → fire | `instanceof AbortSignal` | `AbortSignal.any([sig, …])` | `reason.name` |
|---|---|---|---|---|---|
| raw `Bun.serve` | held | **0.588 ms** | true | works | `AbortError` |
| raw `Bun.serve` | streaming | **0.662 ms** | true | works | `AbortError` |
| **Hono** | **held** | **0.489 ms** | true | works | `AbortError` |
| **Hono** | streaming | **0.861 ms** | true | works | `AbortError` |

### VERDICT: **RESOLVED TRUE**

The hook exists. §5.4's client-disconnect design stands as written; **no polled-liveness fallback is
needed**, and C-9's "within a second" bar is met with three orders of magnitude of headroom.

Three consequences the design can now bank on:

1. **It fires in the held shape**, before any response object exists. That is the case that matters
   — the retry ladder holds without headers — and it was the one in doubt.
2. **It is a real `AbortSignal`**, so §5.4's `AbortSignal.any([clientSignal, attemptCapSignal])`
   composition is available as specified, with `reason.name === "AbortError"`.
3. It fires identically through Hono via `c.req.raw.signal`, which is the accessor §5.4 names.

**One caveat, and it argues in the design's favour.** What was measured is a clean FIN (process
death closes the fd) and an in-process abort. It does *not* cover a silently dead peer — no FIN, no
RST — where the OS would not notice until TCP keepalive expires. That case cannot arise here:
`proxy-server.ts:1140` binds `hostname: "127.0.0.1"`, so claudish's inbound client is always a local
process on loopback, and a local process going away always closes its fd. The half-dead-connection
worry that LOW-5 raised about the `requestIP` fallback does not apply to this hook.

---

## U-1 — is `server.timeout(req, 0)` reachable and effective?

### Method

`u1-server-timeout.ts` — three arms, each a fresh `Bun.serve({ fetch: app.fetch, idleTimeout })`
with a Hono app that holds **12 s** before responding, driven by `curl` (not `fetch`, whose own
client-side timeouts would confound "did the *server* kill it"):

- **control** `idleTimeout: 60`, no disarm — proves the harness itself can hold 12 s.
- **short-idle, NO disarm** `idleTimeout: 5` — the failure this is supposed to prevent.
- **short-idle, WITH disarm** `idleTimeout: 5` and `(c.env as any)?.timeout?.(c.req.raw, 0)`.

It also introspects `c.env` on every arm.

`u1b-idle-granularity.ts` — two follow-ups the first run raised: where exactly the un-disarmed kill
lands relative to the configured value, and whether the disarm holds far beyond 2.4×.

### Raw output

`u1-result.json`:

| arm | `idleTimeout` | disarm called | outcome | client ms |
|---|---|---|---|---|
| control-long-idle-no-disarm | 60 | no | **got body** | 12009 |
| short-idle-NO-disarm | 5 | no | **killed** — `curl: (52) Empty reply from server` | 8012 |
| short-idle-WITH-disarm | 5 | **yes** | **got body** | 12011 |

`c.env` introspection, identical on all three arms:

```
envIsServer:      true          // has port, hostname, requestIP, stop, …
timeoutIsFunction: true
timeoutArity:      2            // (request, seconds)
callThrew:         null
```

`u1b-result.json`:

| arm | `idleTimeout` | hold | disarm | outcome | killed at |
|---|---|---|---|---|---|
| idle3-nodisarm-hold20 | 3 | 20 s | no | killed | **4.008 s** |
| idle5-nodisarm-hold20 | 5 | 20 s | no | killed | **8.011 s** |
| idle10-nodisarm-hold40 | 10 | 40 s | no | killed | **12.016 s** |
| idle5-DISARM-hold30 | 5 | 30 s | **yes** | **got body** | — (survived **6×**) |

### VERDICT: **RESOLVED TRUE**

`c.env` *is* the Bun `Server` (Bun passes it as `fetch`'s second argument, and Hono surfaces that
argument as `c.env` — `proxy-server.ts:1137` mounts `app.fetch` directly, so this holds in
production). `c.env.timeout` is a real 2-arity function, the call does not throw, and calling it with
`0` **prevents the idle kill**: the same request that dies at 8 s without it survives to 30 s with
it — six times the configured idle timeout.

The design's expression `(c.env as any)?.timeout?.(c.req.raw, 0)` is reachable and effective exactly
as written. **The Phase-2 gate is open, and `TIER1_DEADLINE_MS` is not forced down to 180 s by U-1.**

**A side finding the design should not lean on.** The un-disarmed kills land at 4 s, 8 s and 12 s for
configured values of 3, 5 and 10 — every one a multiple of 4, i.e. `ceil(idle/4) * 4`. Bun appears to
round the idle deadline up to a 4-second timer-wheel tick. For claudish's shipped
`idleTimeout: 255` (`proxy-server.ts:1142`) that predicts a real kill at **256 s**, not 255 s. This is
one second of undocumented, version-specific headroom; **record it, do not size a budget against it.**
The disarm makes it moot on the recovery path anyway.

---

## U-2 — where does Claude Code's abort land against a custom base URL?

### Method

`u2-claude-abort.ts` — a stub `Bun.serve` (`idleTimeout: 0`, so only the *client* can end the
request) that accepts everything and never responds. Claude Code is spawned against it with the same
environment `claude-runner.ts` gives the real child:

- `ANTHROPIC_BASE_URL` = the stub (`:1265`)
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` = the placeholders (`:1366-1368`)
- `CLAUDECODE` deleted (`:1301`)
- **`API_TIMEOUT_MS` deliberately not set** — the point is Claude Code's default.

The abort instant is read from the **server** side: U-3 proved `req.signal` fires on disconnect, so
the stub timestamps Claude Code's give-up to the millisecond without parsing its output. Claude
Code's own stdout/stderr is captured too, and every inbound request is logged with its arrival
offset and inter-request gap.

`u2c-timeout-knob.ts` — the same stub with `API_TIMEOUT_MS=20000`, to test whether the measured
number is that knob at its default. A 20 s setting also makes the *whole retry ladder* observable
inside two minutes, which the 6-minute default does not.

### Raw output

**`u2-result.json` — default timeout, 700 s cap:**

| # | method | path | arrived | client aborted | held for | gap from prev |
|---|---|---|---|---|---|---|
| 1 | HEAD | `/api/hello` | 0.088 s | 10.090 s | **10.002 s** | — |
| 2 | POST | `/v1/messages` (`stream:true`) | 0.559 s | 360.166 s | **359.607 s** | 0.471 s |
| 3 | POST | `/v1/messages` (`stream:true`) | 360.767 s | *(700.002 s — our own SIGKILL, not Claude Code)* | ≥339 s | **0.560 s** |

Claude Code was still retrying when the 700 s cap killed it (`exitCode: 137`, `killedByCap: true`).
`stdout` was empty; `stderr` carried only the unrelated connectors warning.

**`u2c-result.json` — `API_TIMEOUT_MS=20000`, 120 s cap:**

| # | path | arrived | aborted | **held for** | gap from previous abort |
|---|---|---|---|---|---|
| 1 | `/api/hello` | 0.087 s | 10.089 s | 10.002 s | — |
| 2 | `/v1/messages` | 0.963 s | 20.963 s | **20.000 s** | — |
| 3 | `/v1/messages` | 21.518 s | 41.518 s | **20.000 s** | **0.555 s** |
| 4 | `/v1/messages` | 42.573 s | 62.573 s | **20.000 s** | **1.055 s** |
| 5 | `/v1/messages` | 64.921 s | 84.920 s | **19.999 s** | **2.348 s** |
| 6 | `/v1/messages` | 89.857 s | 109.857 s | **20.000 s** | **4.937 s** |
| 7 | `/v1/messages` | 118.523 s | *(120.008 s — our cap)* | — | **8.666 s** |

Still retrying at the cap: **six full attempts and a seventh in flight**, exit 137.

### VERDICT: **RESOLVED TRUE — the abort lands at 359.6 s, i.e. ~360 s. Neither 300 s nor 600 s.**

And the number has a name. `API_TIMEOUT_MS=20000` produced aborts at **exactly 20.000 s**, six times
running, with millisecond fidelity. The 359.607 s default is therefore **`API_TIMEOUT_MS` at its
default of 360 000 ms**, not an emergent byte-watchdog behaviour. U-2's underlying claim — that
Claude Code's byte-level watchdog does not arm before response headers on a gateway connection — is
confirmed by implication: nothing fired earlier than the flat request timeout, in either arm.

**Four consequences, in order of how much they change the design.**

**1. `TIER1_DEADLINE_MS` re-derives to 270 s** — but only if the design's own conservatism is kept.
`architecture.md:524-526` states the rule: *"If U-1 resolves true, Bun's 255 s stops binding and the
constraint becomes U-2's measured client ceiling; the constant then rises to `min(measured, 300) −
30`."* U-1 did resolve true and the measured ceiling is 359.6 s, so the rule yields
`min(359.6, 300) − 30` = **270 s**, up from 180 s. The raw measurement would permit up to ~330 s; the
300 s clamp inside the rule is what stops the constant tracking one version's undocumented default,
and it should stay. **Recommendation: `TIER1_DEADLINE_MS = 270_000`, with the 300 s clamp kept and
the reason recorded.**

**2. `API_TIMEOUT_MS` is a user-settable knob that can silently shrink the budget below the
deadline, and the design does not currently read it.** A user with `API_TIMEOUT_MS=60000` in their
shell gets a 60 s client ceiling against a 270 s tier-1 hold: Claude Code aborts four times over
while claudish is still patiently retrying, and every episode ends `client_gone`. The recovery
feature would appear to do nothing, with no error anywhere. Two options, in preference order:

- **Read it.** `deadlineAt = inboundStartedAtPerf + min(TIER1_DEADLINE_MS, API_TIMEOUT_MS − margin)`.
  It is one `Number.parseInt(process.env.API_TIMEOUT_MS)` in `recovery/settings.ts`, which Phase 2
  already builds, and it makes the feature correct instead of merely documented.
- At minimum, **warn once at startup** when `API_TIMEOUT_MS` is set below `TIER1_DEADLINE_MS`.

This was not in the design at any revision. It is the sharpest thing this measurement produced.

**3. Claude Code retries an aborted request on its own, with a ~0.5 s exponential backoff.** Measured
gaps between one abort and the next request: **0.555, 1.055, 2.348, 4.937, 8.666 s** — a clean
doubling off ~0.5 s. Every one of them is two orders of magnitude inside `EPISODE_GRACE_MS`
(120 000 ms), so the grace window is generous rather than tight, and §3.1's resurrect ring is
confirmed as the **safety net** rather than the primary path — for this trigger.

**Stated limit:** these are the gaps after a client-side **abort**. U-4 asks about the gaps after a
**503**, which is a different branch of the SDK's retry logic. That is measured separately below.

**4. Claude Code does not give up quickly.** Six full attempts in 120 s at a 20 s timeout, still
going at the cap. At the 360 s default that is well over half an hour of client-side retrying before
exhaustion.

### Addendum — `u2-long-claude-abort.ts`, the 2400 s replication (PARTIAL at time of writing)

A second run at the default timeout with a 2400 s cap, started to find the total attempt count. It
had not finished when this was written; **reported as partial, per instruction.** Reached
**t = 1084 s / 4 completed attempts**, and it reproduces the first run exactly:

| attempt | held for | gap from previous abort |
|---|---|---|
| #2 `/v1/messages` | **359.422 s** | — |
| #3 `/v1/messages` | **360.076 s** | **0.585 s** |
| #4 `/v1/messages` | **360.072 s** | **1.016 s** |
| #5 `/v1/messages` | in flight | **2.294 s** |

Three independent holds within 0.7 s of each other across two processes, and the same ~0.5 s-doubling
gap sequence as `u2c`. **359.6 s is reproducible, not a one-off.** The run finishes on its own and
writes `u2-long-result.json` beside this file; nothing above depends on its completion, and the
attempt-count question it was chasing is already answered from the other side by U-4 arm C
(~11 attempts before Claude Code exits 1).

---

## F-SLOW fidelity — does `192.0.2.1` actually produce a SLOW failure?

### Method

`fslow-connect-timing.ts` — raw `node:net` connects to TEST-NET-1/2/3 and an unrouted RFC-1918
address, each capped at 30 s, plus a Bun `fetch` (what a transport actually issues) and a control
row: a *known-closed loopback port*, which is the fast-refusal fault every other criterion in
`validation-criteria.md` uses.

`fslow-uncapped.ts` — the same two probes with **no cap** (200 s guard only), because the 30 s cap
could only say "≥ 30 s" and C-18 wants the real number.

### Raw output

`fslow-result.json` (30 s cap):

| target | method | ms | outcome |
|---|---|---|---|
| `127.0.0.1:58135` (closed, control) | tcp | **5** | refused — `ECONNREFUSED` |
| **`192.0.2.1:443`** | tcp | **30001** | **hung to cap** |
| `198.51.100.1:443` | tcp | 30001 | hung to cap |
| `203.0.113.1:443` | tcp | 30001 | hung to cap |
| `10.255.255.1:443` | tcp | 30001 | hung to cap |
| `https://192.0.2.1/v1/messages` | Bun `fetch` | 30001 | hung to cap |

`fslow-uncapped-result.json` (no cap):

| target | method | ms | code |
|---|---|---|---|
| `192.0.2.1:443` | `node:net` | **75004** | `ECONNREFUSED` |
| `https://192.0.2.1/v1/messages` | Bun `fetch` | **75007** | `ConnectionRefused` |

### VERDICT: **RESOLVED TRUE** — F-SLOW is a genuine slow fault on this machine

`192.0.2.1:443` hangs for **75.0 seconds** before the OS gives up. That is macOS's default TCP
connect timeout, and it is 15 000× the 5 ms of the refused-loopback control. C-18's premise holds
and needs no substitute fault. All three TEST-NETs behave identically, so `198.51.100.1` and
`203.0.113.1` are drop-in alternates if one ever starts answering.

**Two findings that change things, both from the uncapped run.**

**1. The error code is `ECONNREFUSED` / `ConnectionRefused`, not `ETIMEDOUT`.** A 75-second hung
connect and a 5-millisecond rejected connect arrive at the classifier **wearing the same code** on
this platform — `node:net` says `ECONNREFUSED`, Bun's `fetch` says `ConnectionRefused` (consistent
with the project's recorded "Bun fetch errors use own codes" note). Any design text that separates a
`refused` class from an `unreachable`/`ETIMEDOUT` class **by error code** is wrong on macOS. The only
thing that distinguishes them here is **elapsed time**. Two consequences:

- The classifier must treat `ConnectionRefused` as transient — which it must anyway for the loopback
  row — and must not expect `ETIMEDOUT` to be the marker of the slow class.
- C-18's third bullet ("`[Recovery]` MUST show attempts at the clamped cap rather than the ladder's
  nominal gaps, which is how you confirm the fault really was slow rather than refused") is now the
  **only** way to tell the two apart. It was a nice-to-have; it is load-bearing.

**2. `PER_ATTEMPT_CONNECT_CAP_MS = 75 s` collides exactly with the OS's own give-up.** The clamp
fires at 75 000 ms; the OS errors at 75 004 ms. A 4-millisecond race decides which one ends the
attempt, and it will not resolve the same way twice. That makes every C-18 assertion keyed on "the
attempt ended at the clamp" flaky by construction. **Move the cap clear of 75 s** — below (30–45 s,
so the clamp always wins and attempts are predictable) or above (90 s, so the OS always wins and the
clamp is a genuine backstop). The design's own §3.2 figure of "20–75 s" for this class is confirmed
at its top end; the constant just must not sit *on* it.

---

## U-4 (bonus) — Claude Code's own retry gaps on a **503**

Not on the task list. Measured because it is the other half of U-2, it costs one minute on
infrastructure already built, and it is the number that decides whether §3.1's resurrect ring is the
primary path or a safety net. The U-2 runs measured gaps after a client-side **abort**; the Tier-2
handoff sends a **503**, which is a different branch of the SDK's retry logic.

### Method

`u4-503-retry-gaps.ts` — same stub shape, but `/v1/messages` answers **503 immediately** instead of
holding. Three arms, one `claude -p` process each, 180 s cap:

- **A** — `503` + `x-should-retry: true` (what the design sends)
- **B** — `503` + `x-should-retry: true` + `retry-after: 5`
- **C** — bare `503`, no `x-should-retry` (control: does the header change anything?)

### Raw output

| arm | attempts | elapsed | exit | gaps between consecutive requests (s) |
|---|---|---|---|---|
| **A** `x-should-retry:true` | 10 | 180.01 s (**our cap**) | 137 | 0.56, 1.25, 2.43, 4.29, 9.05, 17.49, 36.25, 37.88, **38.39** |
| **B** + `retry-after: 5` | 10 | 180.01 s (**our cap**) | 137 | **5.01, 5.00, 5.01, 5.00**, 9.15, 18.10, 32.72, 36.90, 33.33 |
| **C** bare 503 | 11 | 174.19 s (**gave up on its own**) | **1** | 0.54, 1.25, 2.21, 4.70, 8.52, 16.30, 35.64, 34.29, 33.68, 36.27 |

Arm C's arrivals: `0.41, 0.95, 2.20, 4.41, 9.11, 17.63, 33.93, 69.57, 103.86, 137.54, 173.81` —
then exit 1 at 174.19 s, 0.38 s after the eleventh 503.

### VERDICT: **RESOLVED — gaps stay well inside `EPISODE_GRACE_MS`; the ring is a safety net**

**1. The backoff caps at ~38 s.** It doubles off ~0.5 s — 0.56, 1.25, 2.43, 4.29, 9.05, 17.49 — and
then flattens at 36.25, 37.88, 38.39 rather than continuing to 72 s. **Maximum observed gap:
38.39 s**, which is 3.1× inside `EPISODE_GRACE_MS` (120 000 ms). §3.1's resurrect ring is confirmed as
the **safety net**, and `EPISODE_GRACE_MS = 120_000` is right-sized with real margin. This is the
answer §9's U-4 row asked for.

**2. `retry-after` is honoured verbatim, and the design is not using it.** Arm B's first four gaps
are `5.01, 5.00, 5.01, 5.00` against `retry-after: 5` — exact, four times running. From the fifth
retry on, the exponential backoff has grown past 5 s and takes over (9.15, 18.10, …), so the
behaviour is `max(retry-after, exponential)`. **The Tier-2 503 can therefore *set* its own rejoin
gap.** That is a lever the design does not currently pull: sending `retry-after` alongside
`x-should-retry: true` would let the handoff ask Claude Code to come back on claudish's schedule
instead of the SDK's, which matters because the SDK's gap reaches 38 s — long enough for a banner to
look frozen. Worth considering in Phase 4.

**3. Claude Code's 503 budget is ~11 attempts / ~174 s.** Arm C exhausted on its own (exit 1) after
eleven 503s spanning 174 s. That bounds the whole Tier-2 story: however many times claudish hands off,
the client will come back at most ~10 times, and the total handoff window is under three minutes.

**4. `x-should-retry: true` could not be shown to change anything, and the measurement says so.**
Arms A and C have statistically identical gap sequences. Arm A was still retrying at attempt 10 when
our 180 s cap killed it — and its next attempt was due at ~186 s, i.e. **~6 s after the cap**, which is
exactly where arm C stopped. So A may well exhaust at 11 too. **This measurement cannot distinguish
them**; a longer cap would be needed. It does not block anything — the design sends the header
anyway, and 503 is retryable by default in the SDK — but no claim should be made that the header
extends the budget.

---

## U-5 — magmux launch overhead

### Method

Note on numbering: the task calls this U-5; in `architecture.md` §9 the *launch-overhead* uncertainty
with the "above 1 s is grounds to revisit default-on" trigger is **U-6** (§9's U-5 is about
`open_pane`'s split geometry, which is not measured here). Both were answered against the launch
question the task asked.

Timed from spawn instant to **the instant the child itself is running** — the child's first act is to
write a `Time::HiRes` timestamp to a file — not to the wrapper's exit. Both arms run the *identical*
child, so interpreter startup cancels in the delta.

`u5-magmux-overhead.ts` — direct spawn vs `magmux --headless -w --id … -e <script>`, 9 samples plus a
discarded warm-up.

`u5b-login-shell.ts` — three arms, because `architecture.md:1518` specifies the pane command as
`<login shell> -lc '<launcher>; exec claude …'` and RISK-5 (`:1854`) says that shape is deliberate.
So the cost a user actually pays is magmux **plus** a login shell, which `u5` alone did not measure.

*First attempt failed and the failure is instructive:* passing the perl one-liner inline through
magmux's `-e` lost the command entirely — magmux exited 0 in 88 ms, the stamp file never appeared.
Nesting perl's single-quoted `-e` inside magmux's shell string is one quoting layer too many, and it
fails **silently with exit 0**. The rewritten scripts pass a script *file* path. Worth knowing before
Phase 3 builds `magmux-wrapper.ts`.

### Raw output

`u5-result.json` — magmux alone, child-start ms:

| arm | n | min | median | mean | max |
|---|---|---|---|---|---|
| direct | 9 | 369 | **452** | 465 | 714 |
| wrapped | 9 | 435 | **495** | 515 | 718 |

**added: median +43 ms, mean +50 ms** (paired per-run deltas: median +56 ms).

`u5b-result.json` — the design's real shape, child-start ms:

| arm | n | min | median | mean | max |
|---|---|---|---|---|---|
| A — bare script | 9 | 334 | **346** | 361 | 463 |
| B — `zsh -lc <script>` | 9 | 383 | **393** | 412 | 497 |
| C — `magmux --headless -w --id … -e "zsh -lc <script>"` | 9 | 443 | **453** | 463 | 517 |

| component | median | mean |
|---|---|---|
| login shell only (B − A) | **+47 ms** | +51 ms |
| magmux only (C − B) | **+60 ms** | +51 ms |
| **total (C − A)** | **+107 ms** | **+102 ms** |

Exit codes were 0 in every arm of every run.

### VERDICT: **RESOLVED TRUE — well under the bar**

The design's wrapper shape adds **107 ms median / 102 ms mean** to the moment the child starts:
~47 ms for the login shell, ~60 ms for magmux. That is **4.7× under C-16's 500 ms MUST** and
**9× under the 1 s "revisit default-on" trigger**. Default-on is not in question on launch cost.

**Scope limit, stated rather than papered over.** This measures a trivial `sh`/`perl` child. It does
**not** measure the real `claude` launch, and it says nothing about C-16's other three assertions —
Ctrl-C exiting cleanly, exit-code propagation, or the `[Claude Code]` structural exit line still
appearing. Those need the actual wrapper and belong in Phase 3, where C-16 is scheduled. What Phase 0
establishes is only that **launch latency is not the reason to reconsider**, and it establishes that
firmly: even the worst single wrapped sample (718 ms) beat the *best*-case 1 s trigger.

---

## Source claim — `getHeaders()` outside every `try`, and `gk@`'s first network touch

The round-3 review claimed: `composed-handler.ts:592`'s `getHeaders()` sits outside every `try`, and
for `gk@` (Grok subscription) token refresh happens inside `getHeaders` via `grok-credentials.ts:481`,
making it the request's first network touch, where an outage escapes `handle()` and can advance a
subscription onto metered billing.

Verified by reading the source. **Nothing was changed.**

### Half 1 — is line 592 outside every `try`?

**HOLDS.** `ComposedHandler.handle()` opens at `:287` and closes at `:1175`. The `try` blocks inside
it, in order: `520–535`, then **`616–620`**. Line 592 —

```ts
const endpoint = this.provider.getEndpoint(this.targetModel);
const headers = await this.provider.getHeaders();
```

— falls in the gap between them. It is inside no `try` at all. A throw there propagates straight out
of `handle()`.

### Half 2 — is `grok-credentials.ts:481` reached from `getHeaders`, and is it a network call?

**HOLDS, with one qualification the review did not state.** The chain, each hop read:

```
composed-handler.ts:592      await this.provider.getHeaders()
  → transport/grok-subscription.ts:40   getHeaders()
      → credentials.getRequestAuth("grok-subscription", { model })
          → auth/credentials/grok-credential.ts:57   resolveGrokAccessToken()
              → providers/grok/grok-credentials.ts:481   export async function resolveGrokAccessToken()
                  → refreshShared(cred)
                      → :418   await fetch(tokenEndpoint, { … })    ← NETWORK
```

`grok-credentials.ts:481` is `resolveGrokAccessToken`'s declaration line exactly, as claimed.

**The qualification:** the network call is *conditional*. `resolveGrokAccessToken` returns the cached
token without touching the network when `!isGrokCredentialExpired(cred)`; it reaches `refreshShared`
→ `fetch` only when the token is expired (or when the claudish-owned OAuth store needs a refresh).
`grok-subscription.ts:30-39` says so in its own comment — "cheap when the token is live (one small
file read)". So this is the request's first network touch **on the refresh-due request**, not on
every request. That makes it *rarer*, not safer: it is an uncommon path that fails only during an
outage, which is precisely the combination a test suite misses.

### Half 3 — does the escape actually advance the chain? (not asked; checked because it is the claim's teeth)

**YES.** `fallback-handler.ts:63` calls `await handler.handle(c, payload)` inside a `try` whose catch
at `:113` is:

```ts
} catch (err: any) {
  errors.push({ provider: name, status: 0, message: err.message });
  if (!isLast) {
    logStderr(`[Fallback] ${name} error: ${err.message}, trying next provider...`);
  }
}
```

No classification, no transience check. Any throw — including a DNS failure or a refused connect
inside the Grok token refresh — is recorded as `status: 0` and the loop advances to the next
candidate. On a subscription-first roster the next candidate bills per token. The
`hasQuotaExhaustionWording` notice at `:100-104` is on the *non-throwing* branch only, so this path
advances **without even the cost warning**.

### Half 4 — the escape has a SECOND landing site, and it is also unclassified

`handle()` has exactly two call sites (`proxy-server.ts:1101`, `:1110`, `fallback-handler.ts:63`).
When routing yields a **single** candidate there is no `FallbackHandler` in the way, and the throw
lands in `proxy-server.ts:1111`:

```ts
} catch (e) {
  log(`[Proxy] Error: ${e}`);
  if (e instanceof RoutingError) {
    return c.json(wrapAnthropicError(400, e.message, "invalid_request_error"), 400);
  }
  return c.json(wrapAnthropicError(500, String(e)), 500);
}
```

A network failure inside `getHeaders()` is not a `RoutingError`, so it becomes a bare **500** with
`String(e)` as the message — no classification, no retry, no recovery episode. The repo already knows
this shape: the comment immediately above, at `:1106-1109`, exists because a missing `await` once let
rejections skip this catch entirely and says so — *"That is how connect failures bypassed every
message we build here."*

So the same escaping error produces **two different unclassified outcomes** depending only on how
many candidates the route produced: a silent chain advance onto metered billing, or a generic 500.
Whatever Phase 1 does about `:592`, it has to cover both.

The claim holds in full, and its consequence is worse than stated: **neither** catch that can receive
the escaped error classifies it.

### VERDICT: **CLAIM HOLDS** (both halves; qualified only on "first network touch" being
refresh-conditional rather than per-request)
