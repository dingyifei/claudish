# Network recovery, Phase 7 — real validation at HEAD, with the C-8 regression fixed

> Promoted out of the gitignored session directory deliberately, as
> `network-recovery-phase0-measurements.md`, `-phase2-verification-`, `-phase3-pane-` and
> `-phase4-status-flip-` were. CLAUDE.md records three write-ups already lost because they lived in
> `ai-docs/sessions/`, which does not survive a fresh clone or `git worktree remove`.
>
> Session `dev-feature-network-recovery-20260910-110514-0ad0a5a0` · measured 2026-09-11/12 on
> macOS 25.6.0, bun 1.4.0, magmux 0.11.0, Claude Code 2.1.269, ollama 0.33.3 `qwen2.5:0.5b`.
>
> **This supersedes the FAIL revision of this report.** That revision found C-8 failing —
> `--no-recovery` still wrapped the session in magmux — and left C-9, C-10, C-13, C-14, C-15, C-16,
> C-17 and C-19 unverified at HEAD. All of that is closed here: the gate is fixed and
> mutation-proven, and every one of the nineteen criteria is demonstrated with captured output.
>
> Harnesses and raw captures live in that session's `validation/` directory. They are gitignored;
> the figures, the findings and the judgements are here.

**Status**: PASS

All nineteen criteria are demonstrated at HEAD with captured evidence, including all four
non-waivable ones (**C-6, C-12, C-17, C-18**). The C-8 regression this file reported as a FAIL —
`--no-recovery` still wrapping the session in magmux — is fixed, mutation-proven and re-observed on
four real launches. C-11's unmeetable number is withdrawn against a measured control. C-17, the
non-waivable criterion nothing had ever reached, is demonstrated through `LocalProviderTransport`
against a real stopped `ollama serve`. The seven criteria the earlier phase's brief omitted are
demonstrated rather than assumed.

Two caveats are carried forward rather than buried, and neither is a regression:

- `bun run test:safe` is **3451 pass / 18 skip / 2 fail**. Both failures are `displayWidth` oracle
  tests, and both were **reproduced at `3c1fa26`**, the commit before this feature.
- `--no-recovery` does not restore pre-recovery behaviour "byte for byte". It restores the outcome
  and the launch; it deliberately keeps one response header and one clamp. Measured against a
  control, and `network-recovery.md` §7 now says so instead of the old claim.

---

## Which binary every run used

The installed global `claudish` has none of this code in it, and a version string cannot tell the
builds apart — all three say `9.2.0`. Recorded before anything else:

| build | path | bytes | `x-claudish-recovery` | `x-claudish-connection-error` | `recoverySurfaceAllowed` |
|---|---|---|---|---|---|
| **branch (HEAD + phase-7 fix)** | `…/worktrees/recover/packages/cli/dist/index.js` | 3 611 226 | **yes** | **yes** | **yes (4×)** |
| installed global | `~/.bun/install/global/node_modules/claudish/dist/index.js` | 2 527 490 | no | no | no |
| baseline `3c1fa26` | `…/scratchpad/baseline/packages/cli/dist/index.js` | 3 538 289 | no | no | no |

`recoverySurfaceAllowed` is the marker that distinguishes this phase's build from the one the earlier
validation used; it is the C-8 fix itself.

Every run below used one of three things, named per row:

- **`packages/cli/bin/claudish.cjs` by absolute path** — the branch launcher → branch `dist/index.js`.
  `recoveryPaneCommandLine()` builds the pane's command from `process.argv[1]`, so the recovery pane
  is the same build.
- **`bun` importing `packages/cli/src/**` from this worktree** for in-process harnesses.
- **the baseline worktree at `3c1fa26`**, built with the same toolchain, as the control for C-11,
  F-4, the §7 comparison and the two `displayWidth` failures.

Evidence: `env/probe-env.txt`, `s7/`.

## The faults, verified real on this machine before use

| id | fault | measured | code |
|---|---|---|---|
| F-REFUSED | verified-free high port, taken with `Bun.serve({port:0})` then released | **0.19–0.55 ms** | `ConnectionRefused` |
| F-REFUSED-LOCAL | a real `ollama@` spec whose server is not running | **0.55 ms** on `/api/tags` | `ConnectionRefused` |
| F-DNS | `https://no-such-host.invalid` (RFC 2606) | **14.0 ms** | `ENOTFOUND` |
| F-SLOW | `https://192.0.2.1` (TEST-NET-1, RFC 5737) | **75 009 ms** | `ConnectionRefused` |
| F-RESET | a stub that accepts, READS THE BODY (1550 bytes), then RSTs | immediate | `ECONNRESET` |

F-SLOW is re-checked every run because `192.0.2.1` is unrouted *by convention*. F-SLOW and F-REFUSED
report the **same code** — only elapsed time separates them on macOS.

---

## Results

| criterion | status | evidence |
|---|---|---|
| **C-1** — a connection error no longer ends the turn | **PASS** | `c1-c6/tier1/`, `c1-c6/tier2/` — `API Error: 400` polled every 5 s over both whole runs, never seen. Re-confirmed at HEAD by `c17/steps.txt` (`false`) |
| **C-2** — the ladder shape, handoff derived from the deadline | **PASS** | `c2/c2-default.txt`, `c2/c2-90s.txt`, `c2/c2-30s.txt` |
| **C-3** — red banner names provider, host, reason | **PASS** | `c3-c5/C-3-banner.txt`, `c18/C-18-run1-at-exhaustion.txt`; a third fault class at HEAD in `c17/C-17-banner-early.txt` |
| **C-4** — the countdown is live | **PASS** | `c3-c5/C-4-countdown-a.txt` / `-b.txt` |
| **C-5** — `[r]` collapses the wait | **PASS** | `c3-c5/steps.txt`, `c3-c5/recovery-log.txt` |
| **C-6** — recovery completes the turn, tier 1 **and** tier 2 | **PASS** | `c1-c6/tier1-run.out`, `c1-c6/tier2-run.out` |
| **C-7** — healthy path unchanged, against a live provider | **PASS** | `c7/ttft-interleaved.txt`, `c7/magmux-overhead.json` |
| **C-8** — the three switches | **PASS — regression fixed** | `c8/c8-matrix.md` (20/20), `c8/c8-no-recovery-wrap-live-fixed.txt` (4/4 real launches), `packages/cli/src/recovery/settings.test.ts` |
| **C-9** — client disconnect stops the retry loop | **PASS** | `c9/steps.txt`, `c9/recovery-log.txt` |
| **C-10** — full suite green | **PASS (2 pre-existing failures, reproduced on the control)** | `quality/` — 3451 pass / 18 skip / 2 fail; typecheck, lint, format clean |
| **C-11** — probes never enter the ladder | **PASS (criterion amended)** | `c11/c11.txt`, `c11/c11-header-effect.txt`; the withdrawn number is `validation-criteria.md` amendment 18 |
| **C-12** — no chain advance, 400 arm, quota wording | **PASS** | `c12/c12-400arm-quota-steps.txt`, `…-plain-steps.txt` |
| **C-13** — a duplicate charge is attributable across a handoff | **PASS** | `c13/steps.txt`, `c13/stats-events.json`, `c13/recovery-log.txt` |
| **C-14** — a recovery 503 survives an auto-routed chain | **PASS** | `c14-c15/steps.txt` RUN A, `c14-c15/C-14-response.json` |
| **C-15** — the 503 gate is revoked when the banner goes away | **PASS (both halves)** | `c14-c15/steps.txt` RUN B and RUN C, `C-15a-response.json`, `C-15b-response.json` |
| **C-16** — launch overhead and fidelity | **PASS** | `c16/steps.txt`, `c16/c16-results.json` |
| **C-17** — a real local provider recovers | **PASS — the gap is closed** | `c17/steps.txt`, `c17/probe-series.txt`, `c17/recovery-lines.txt`, `c17/C-17-final.txt` |
| **C-18** — Tier 2 engages for a slow fault | **PASS** | `c18/run.out`, `c18/C-18-run1-lease-samples.txt` |
| **C-19** — a network drop during a forced auth retry does not advance the chain | **PASS** | `c19/steps.txt`, `c19/C-19-response.json`, `c19/log-lines.txt` |
| **F-4** — `[Recovery]` visible without `--debug` | **PASS** | `f4/f4.txt`, `f4/f4-HEAD-stderr.txt` |

---

# THE FIXED REGRESSION — C-8

## `--no-recovery` now skips the magmux wrap

`claude-runner.ts:1550` gated the wrap on `resolveRecoveryUi()` alone; `cli.ts:340` sets only
`{ recovery: false }` for `--no-recovery`, so the UI switch stayed at its default `true` and the
session was wrapped anyway. The ambient branch at `:1584` had the same shape. `retryWatchdogEnv()`
asked **both** switches from the start, which is what made this a gate gap rather than a design
problem — and what made it invisible: the watchdog half of the same switch worked.

One predicate now answers the question everywhere:

```ts
export function recoverySurfaceAllowed(): boolean {
  return resolveRecoveryEnabled() && resolveRecoveryUi();
}
```

read by `retryWatchdogEnv()`, by the wrap ternary (`claude-runner.ts:1557`) and by the ambient-socket
branch (`:1591`).

**Observed on four real launches of the rebuilt branch build**, each on its own PTY, asking the
operating system which processes exist (`c8/c8-no-recovery-wrap-live-fixed.txt`):

```
A  default (no switch)     magmux --id claudish-*: PRESENT   expected PRESENT   PASS
      21791 21735 /opt/homebrew/bin/magmux --id claudish-21735 --no-idle-done -w --no-status -e . '…'
B  --no-recovery-ui        magmux --id claudish-*: absent   expected absent   PASS
C  --no-recovery           magmux --id claudish-*: absent   expected absent   PASS
D  CLAUDISH_RECOVERY=0     magmux --id claudish-*: absent   expected absent   PASS

VERDICT — "--no-recovery also skips the magmux wrap": TRUE
VERDICT — "CLAUDISH_RECOVERY=0 also skips the magmux wrap": TRUE
```

Arm D is new: the flag and the environment variable are documented as the same switch, and a fix that
reached only the flag would be a second half-working control.

The in-process matrix is **20/20** (was 17/20), and `c8-row.ts` now IMPORTS `recoverySurfaceAllowed`
rather than restating the two switches, so it cannot disagree with production about what they mean.

## The regression test, and the two mutations that kill it

`recovery/settings.test.ts` gains five behavioural tests and two source guards. The source guards
exist because the defect was in the CALL SITE, not in the expression: reaching `claude-runner.ts:1557`
in a unit test means spawning Claude Code inside a real magmux on a real TTY. They strip comments
first — the comments there name `resolveRecoveryUi()` while explaining why it is not enough, and an
unstripped guard would pass on reverted code.

**Mutation A** — revert the predicate body to `return resolveRecoveryUi();` (file copy, never git):

```
(fail) recoverySurfaceAllowed … > --no-recovery withdraws the surface even with the UI switch left ON
(fail) recoverySurfaceAllowed … > every layer of the master switch withdraws it, not just the flag
(fail) recoverySurfaceAllowed … > the watchdog moves with it — surface and reach are one decision
27 pass / 3 fail
```

**Mutation B** — revert both `claude-runner.ts` call sites:

```
(fail) claude-runner asks that gate … > the magmux wrap ternary consults recoverySurfaceAllowed()
(fail) claude-runner asks that gate … > the ambient-magmux branch consults it too
28 pass / 2 fail
```

`30 pass / 0 fail` after each restore.

## …and §7's claim is still not "byte for byte" — now measured, and rewritten

The brief asked whether the fix makes §7 true. It does not, and saying so needed a control: a
detached worktree at `3c1fa26` — the commit before this feature — installed and built with the same
toolchain. `s7/s7-arm.ts` imports `ComposedHandler` dynamically from whichever tree it is given, so
one script measures both arms.

```
refused port, same request, same handler shape

                                  branch + CLAUDISH_RECOVERY=0     baseline 3c1fa26
status                            400                              400
body                              174 bytes, identical text        174 bytes
elapsed                           12 ms                            7.4 ms
headers                           + x-claudish-connection-error: 1  —
```

And with a HUNG upstream (accepts, reads, never answers), `API_TIMEOUT_MS=45000`, client patience
60 s — `s7/s7-hang-arm.ts`:

```
branch + CLAUDISH_RECOVERY=0   400 at 15 014 ms   (the derived floor deadline)
baseline 3c1fa26               no answer; the client gave up at 59 986 ms
```

Both differences are deliberate and both make the opt-out path **better** than what it replaced: the
marker header is what stops a connection error whose message contains "quota" from advancing the
fallback chain onto metered billing, and removing it under the switch would hand the opt-out user
that bug back; the clamp's alternative is the second row above. `network-recovery.md` §7 now carries
this table and states what the switch does and does not restore.

---

# C-17 — the non-waivable criterion nothing had ever reached

Every other criterion induces its fault through a **custom endpoint**, and
`custom-endpoints-loader.ts` builds those on the OpenAI / Anthropic / LiteLLM transports — none of
which implements `refreshAuth`. So C-1…C-6, C-12, C-18 and the whole integration suite enter the
FETCH path and never touch `local.ts`. This run uses `--model ollama@qwen2.5:0.5b` with
`OLLAMA_BASE_URL` pointed at a verified-free high port, and starts a **real `ollama serve`** on that
port mid-ladder against the same model store.

```
[0.2s]   fault confirmed: ollama's own /api/tags on 127.0.0.1:64045 refuses in 0.554 ms (ConnectionRefused)
[8.2s]   LADDER opened at t+8s — the episode exists
[53.3s]  STARTED a real `ollama serve` on 127.0.0.1:64045 — probes while it was DOWN: 16 (/api/tags 8, /v1/models 8)
[123.3s] the turn produced an answer
```

| assertion | result |
|---|---|
| 1 — the banner renders and the ladder runs | **true**, and it names the provider; 8 failed attempts |
| 2 — exactly ONE `recovery_episode_id` | **1** — `959247f2-4c39-4bb7-a8ca-02516fc177ef` |
| 3 — no `recovered` before the successful 200 | **true** — first `recovered` at 23:03:45, server started 23:02:53 |
| 4 — the lines name the PROBE endpoint | **true** — `…/v1/models`, never `/v1/chat/completions` |
| 5 — the held request completes with a real answer | **true** |

**THE PROBE COUNT, which is what proves a retry genuinely re-probes.** `local.ts:160` is
`if (this.healthChecked) return;`, and `checkHealth()` used to set `healthChecked = true` on FAILURE —
so attempt 2 returned success without probing and the episode closed `recovered` for an outage that
never ended. Sampled every 5 s (`c17/probe-series.txt`):

```
[8s]   attempts=2 probes=4  (tags=2 models=2) server=false
[13s]  attempts=4 probes=8  (tags=4 models=4) server=false
[23s]  attempts=6 probes=12 (tags=6 models=6) server=false
[53s]  attempts=8 probes=16 (tags=8 models=8) server=true   ← the server starts here
[113s] attempts=8 probes=18 (tags=10 models=8) server=true  upstream200=1
```

**Exactly two probes per attempt while the server was down** — one `/api/tags`, one `/v1/models` —
and at recovery `tags=10 models=8`, because the successful `/api/tags` short-circuits before
`/v1/models` is tried. A latched `healthChecked` is a flat probe count under a rising attempt count;
this is the opposite.

The banner, mid-outage and at the end (`c17/C-17-banner-early.txt`, `c17/C-17-final.txt`):

```
  ██ NETWORK · Ollama refused
  Cannot connect to Ollama at http://127.0.0.1:64045/v1/models. Make sure the server is running.
  host 127.0.0.1:64045 · ConnectionRefused · local
  next attempt in 1s · attempt 2 · 4s in recovery
  last: ConnectionRefused · 2 requests held
  click here or Ctrl-G Tab, then [r] try now · [q] give up
```

```
❯ Reply with exactly one word: banana
⏺ banana
✻ Sautéed for 1m 58s · done 9:03 am
────────────────────────────────────────────────────────────────────────────
  * ollama@qwen2.5:0.5b |  wt:work  | $0.15 | 2m0s | 󰍛 397M | ░░░░░░ 15% • Ollama
────────────────────────────────────────────────────────────────────────────
  ██ NETWORK · Ollama recovered
  8 attempts over 1m 59s
  this pane closes on its own
```

The ladder, with **two waiters on one episode**, one timer, and the whole `5 / 10 / 30 / 60` sequence
(`c17/recovery-lines.txt`):

```
23:02:00.560 [Recovery] episode 959247f2-… opened for Ollama at http://127.0.0.1:64045/v1/models (refused/ConnectionRefused)
23:02:00.567 [Recovery] recovery pane opened (magmux pane 2)
23:02:00.767 [Recovery] pane is painting episode 959247f2-… — lease granted (paneOpen=true)
23:02:05.563 [Recovery] Ollama waiting 10s before attempt 4 (episode 959247f2-…, 2 waiting)
23:02:15.565 [Recovery] Ollama waiting 30s before attempt 6 (episode 959247f2-…, 2 waiting)
23:02:45.567 [Recovery] Ollama waiting 60s before attempt 8 (episode 959247f2-…, 2 waiting)
23:03:45.645 [Recovery] Ollama recovered after 9 attempts in 105085ms (episode 959247f2-…)
23:03:45.648 [Recovery] episode 959247f2-… closed: recovered after 105088ms and 10 attempts
```

> **A finding this run produced, and the reason the harness header warns about it.** The first recon
> used `API_TIMEOUT_MS=60000` to be quick, and recorded
> `[Recovery] skipped (no-budget) — Ollama at …, site=refreshAuth` at t+0 with no ladder at all. The
> auth path's deadline is `refreshDeadlineAt(tier1DeadlineAt(c))` = deadline − 45 s, so **any
> `API_TIMEOUT_MS ≤ 75 000` puts the auth-path deadline in the past and the local-provider ladder
> never runs.** It is inside the documented reserve, but the consequence — a whole fault class losing
> recovery on a user-settable knob, silently — is not written down anywhere. See the report's
> findings.

---

# The seven criteria the earlier brief omitted

## C-9 — a client disconnect stops the retry loop

A real magmux, a real `claudish recovery-pane` process, a real proxy on a real socket, and a real
client abort — `c.req.raw.signal` cannot fire for a synthesised context, so nothing less would do.

```
[15.6s] ladder is running: 3 failed attempts so far
[15.6s] recovery socket dir: /tmp/claudish-recovery-945d3cf683ec8186cc4767d7   (exists: true)
[15.6s] CLIENT ABORTED (this is Claude Code being killed mid-retry)

C-9.1 attempts before abort            : 3
C-9.1 attempts 20 s AFTER the abort    : 3      ← a 30 s rung was armed; it never fired
C-9.2 episode closed client_gone after : 303 ms (MUST be < 1000)
C-9.2 handler settled after            : 1 ms — responded 499
C-9.3 socket dir removed after         : 30 076 ms
C-9.3 orphaned recovery-pane processes : 0
```

`[Recovery] episode … closed: client_gone after 15330ms and 3 attempts` — **not** the 120 s handoff
grace, which is the distinction the criterion was amended to make. The 20-second wait afterwards is
deliberate: the armed rung was 30 s, so anything still retrying would have shown up in that window.

The socket directory goes at **30 076 ms**, which is `PANE_LINGER_MS` exactly — `releaseEpisodeUi`
starts a 30 s linger rather than tearing down at once, so the pane does not flap open and shut on
every client-retry cycle and the last thing that happened stays readable. Reported as measured rather
than as "immediately": the request is released in 1 ms, the surface follows on its own timer.

## C-10 — full suite, typecheck, lint, format

```
bun run test:safe   3451 pass / 18 skip / 2 fail   (228 files, 440.9 s)
bun run typecheck   clean
bun run lint        clean (22 warnings, pre-existing, exit 0)
bun run format      clean — no files changed
```

The two failures are `displayWidth fallback — measured against the oracle …`. **Reproduced on the
control build** at `3c1fa26`:

```
cd <baseline worktree> && bun test packages/cli/src/tui/viz/color.test.ts
  29 pass / 2 fail
```

So the nonzero count is real signal, as the project's recorded baseline requires — and what it points
at is a Unicode width oracle that predates this branch, not this feature. The suite was **7 tests
larger** than the phase's opening baseline (3444), which is the C-8 regression test.

The suite was run alone, after every timing-sensitive run had finished.

## C-13 — a duplicate charge is attributable across a handoff

The fault is the one that costs money: a stub that ACCEPTS the connection, READS THE BODY, and only
then RSTs — so the upstream had the prompt and may already have been generating.

```
upstream connections accepted            : 5   (MUST be >= 3)
request bytes the upstream READ          : 1550
tier-2 handoff observed                  : true
stats records with a recovery_episode_id : 2
distinct recovery_episode_id values      : 1   ← 06376329-b748-4c8a-bee8-34dc5ed660ef
  retry_attempts=2 recovery_ms=15007 client_retry=0 outcome=handoff latency_ms=15012
  retry_attempts=1 recovery_ms=27002 client_retry=1 outcome=handoff latency_ms=27002
```

`retry_attempts` is **per-request** (2 then 1), `recovery_client_retry` is **per-episode** (0 then 1),
and the episode id is the same across both — which is the two-scope design doing the one thing that
cannot be reconstructed afterwards. The rejoin is visible in the log, carrying the ladder position
rather than resetting it, and so is the truncated rung:

```
[Recovery] Reset Probe rejoined episode 06376329-… (client retry 1, ladder 2, attempts 3)
[Recovery] Reset Probe waiting 26.999189458s before attempt 5 (episode 06376329-…, 1 waiting)
```

Bun's `os.homedir()` ignores `$HOME`, so the buffer cannot be relocated that way (measured). Consent
is granted through `setConfigFileOverride`, the machine's real buffer is snapshotted and restored —
`restored to its original 748 bytes — ok=true` — and the override carries a fresh `stats.lastSentAt`
so `checkAndFlush()` cannot POST these synthetic records anywhere.

## C-14 — a recovery 503 survives an auto-routed chain

Candidate 1 answers a real `401` (a response, so it is accumulated as a non-transient chain error —
the condition `exhaustedChainStatus` demotes on). Candidate 2 is unreachable and exhausts recovery
with the pane alive and the lease held.

```
RUN A status                : 503   (MUST be 503, never 400)
RUN A x-should-retry        : true
RUN A x-claudish-recovery   : 1
RUN A lease at exhaustion   : {"paneOpen":true,"lastAckAgoMs":85,"valid":true}
RUN A banner painted        : true
RUN A body: {"type":"error","error":{"type":"overloaded_error","message":"Cannot connect to
  Unreachable Metered at http://127.0.0.1:51888/v1/chat/completions. … claudish retried 3× over 15s
  without reaching it — still trying, watch the recovery pane."}}
```

## C-15 — the 503 gate is revoked when the banner goes away

**(b) `[q] give up`, pane alive and painting** — the half a lease-only test cannot see, because the
pane that took the keystroke is by definition alive:

```
pressed [q] in the recovery pane after 6.7 s
RUN B answered 400 — 1 ms after the keypress
RUN B x-claudish-recovery        : (absent)
RUN B x-claudish-connection-error: 1
RUN B attempts at the keypress   : 5
RUN B attempts 3 s later         : 5        ← the ladder stopped
RUN B follow-up request inside the give-up window: 400 in 1 ms (the ladder is SKIPPED)
```

That last line is the process-level give-up doing what the design says it must: the NEXT request
during the same outage — and Claude Code always has one — is not held for a multi-minute deadline
with the reason legible nowhere.

**(a) the pane PROCESS killed mid-ladder** — not `installRecoveryUi(null)` and not a closed control
socket, but the renderer dying and its heartbeats stopping, which is the only thing that tells a
lease from a latch:

```
lease before the kill : {"paneOpen":true,"lastAckAgoMs":138,"valid":true}
SIGKILLed the recovery-pane process (pid 83569) at t+6.3 s
RUN C held for 45.0 s
RUN C status                     : 400
RUN C x-claudish-recovery        : (absent)
RUN C x-claudish-connection-error: 1
RUN C lease at exhaustion        : {"paneOpen":true,"lastAckAgoMs":39122,"valid":false}
```

> The first attempt at this run killed the pane 8.7 s before a 15 s exhaustion and read
> `lastAckAgoMs: 9124, valid: true` → 503 (`c14-c15/run-first-attempt-lease-window.out`). That is
> `UI_LEASE_MS` = 10 000 behaving exactly as specified — a lease, not a liveness ping — and it is
> also the precise bound on the forbidden state: a renderer that dies inside the last 10 s of a hold
> still grants the 503. Kept as evidence; the passing run uses a 90 s deadline so the renderer is
> dead for four lease windows.

## C-16 — launch overhead and fidelity

Both arms are real `claudish -i` launches on a real PTY with a real Claude Code, differing only by
`--no-recovery-ui`, alternating so drift cannot favour one arm, `--quiet` in both so the update OFFER
— a blocking prompt whose answer latency is the harness's — is out of the measurement.

```
TTFF direct  (n=8) : [1403,1033,1051,1068,1067,1048,1047,1174] median 1067 ms
TTFF wrapped (n=8) : [1351,1324,1330,1356,1356,1376,1318,1370] median 1356 ms
ADDED by the wrap  : 289 ms      (MUST be <= 500; above 1000 revisits default-on)

Ctrl-C on a wrapped session : exit code 0, [Claude Code] line true
child exited 42; the wrapper reported: 42
"[Claude Code] Exited …" in every wrapped run's log : true   (and every direct run's)
```

Four complete runs of part 1 across the session: **+284, +296, +475, +289 ms**. The 8-pair run is the
headline; the +475 outlier is recorded because it is the one sample that comes near the bar, and it
came from a run whose *direct* arm was also slower.

Part 3 needed two harness corrections, both recorded in the script: magmux is a multiplexer and
reports `null` with `stdio: "ignore"` (no terminal to bind a control socket to), and a pane that
exits INSTANTLY takes magmux down with `-w` before `watch()` has polled the socket into existence.
Claude Code lives for minutes, so production meets neither.

## C-19 — a network drop during a forced auth retry does not advance the chain

Candidate 1's upstream answers a real 401 on connection 1 and RSTs every connection after it, so the
drop lands exactly on the forced-auth retry. Candidate 2 is a **healthy** server that would answer
200 and say `METERED-SERVED` — so "the chain did not advance" is not read off a log line alone.

```
status                           : 400        (MUST be 400 or 503 — NEVER 401)
x-claudish-connection-error      : 1
body: {"type":"error","error":{"type":"connection_error","message":"Cannot reach Sakana Fugu at
  http://127.0.0.1:52917/v1/chat/completions. Check your network connection."}}

candidate 1 (subscription) hits  : 1    — the 401 that armed the retry
forceRefreshAuth() calls         : 3    (MUST be >= 1 — the branch was entered, and re-issued)
candidate 2 (metered) hits       : 0    (MUST be 0 — nobody paid for this outage)
[Fallback] … trying next provider: 0
body mentions METERED-SERVED     : false
```

`forceRefreshAuth()` called **three** times is the ladder re-issuing the whole auth-retry operation,
which is the point of making `doAuthRetry` the re-issuable unit rather than just the fetch.

> The first version of this harness stopped candidate 1's server in a microtask after returning the
> 401. The 401 never reached the client, attempt 1 failed `ECONNRESET`, and the 401 branch — the
> entire subject of this criterion — was never entered, while every chain assertion still passed. A
> fault induced through the wrong entry point exercises different code than users hit; that is the
> same lesson C-17 exists for, met twice in one session.

---

## C-11 — the criterion was wrong, and it is the criterion that changed

The state half and the mechanism half both hold at HEAD:

```
F-REFUSED http://127.0.0.1:50144     HEAD               state=network-error  latency=2254ms
F-REFUSED http://127.0.0.1:50144     baseline 3c1fa26   state=network-error  latency=2066ms
F-DNS https://no-such-host.invalid   HEAD               state=network-error  latency=2065ms
F-DNS https://no-such-host.invalid   baseline 3c1fa26   state=network-error  latency=2140ms
HEAD ever reported `timeout` : false

WITH    x-claudish-no-recovery: 1  (what a probe sends)      held    9 ms · 400 connection_error
WITHOUT the header                 (what a real turn sends)  held 5006 ms · 400 connection_error
```

The literal "under a second" is met by **neither** build, and a plain OpenAI transport with no
recovery code in the path shows the same ~2.1 s floor (2 644 ms). A requirement the pre-feature build
also fails is not a statement about this feature — it was written without a control. It is withdrawn
in `validation-criteria.md` (amendment 18) and replaced by the two properties that can actually fail:
the header collapses the hold **556×**, and `timeout` is never reported. Anyone who wants a wall-clock
bound for probes should raise it against `probe-live.ts`'s own budget, with 2.1 s as its baseline.

---

## Environment

macOS 25.6.0 (Darwin 25.6.0, arm64) · bun 1.4.0 · magmux 0.11.0 (8ce5ef8) · Claude Code 2.1.269 ·
ollama 0.33.3 with `qwen2.5:0.5b` · branch HEAD `60cdb37` + the phase-7 C-8 fix · control build
`3c1fa26` · measured 2026-09-11/12.

The full suite was deliberately **not** run concurrently with any timing-sensitive validation run.

---

# Findings that are not criteria

Three things this round measured that no criterion asks for, recorded because each one would
otherwise have to be rediscovered.

## 1. `API_TIMEOUT_MS ≤ 75 000` silently disables the AUTH-path ladder entirely

The auth-path catches use `refreshDeadlineAt(tier1DeadlineAt(c))`, which is
`deadlineAt − PER_ATTEMPT_CONNECT_CAP_MS` (45 s). The tier-1 deadline is itself
`max(15 s, min(API_TIMEOUT_MS, 300 s) − 30 s)`. So:

| `API_TIMEOUT_MS` | tier-1 deadline | auth-path deadline | auth ladder |
|---|---|---|---|
| unset (360 000) | 270 s | 225 s | runs |
| 120 000 | 90 s | 45 s | runs |
| **75 000** | **45 s** | **0 s** | **never runs** |
| **60 000** | **30 s** | **−15 s** | **never runs** |

Measured, not derived — a real `claudish -p --model ollama@qwen2.5:0.5b` against a dead ollama with
`API_TIMEOUT_MS=60000`:

```
[Ollama] Health check FAILED - provider not available
[Recovery] skipped (no-budget) — Ollama at http://127.0.0.1:59999/v1/models, site=refreshAuth
[Ollama] Cannot connect to Ollama at http://127.0.0.1:59999/v1/models. … (code=ConnectionRefused, site=refreshAuth)
```

The reserve itself is deliberate and `transient-retry.ts` explains why. What is not written down is
the consequence at the low end: on a machine with `API_TIMEOUT_MS=60000` — a value
`docs/advanced/environment.md` invites — a stopped local server, a Grok token exchange and every
other auth-path connection failure lose recovery completely and silently, while the fetch path keeps
it. This is the same *shape* as the truncated-rung defect §2 already records (a budget that stops
fitting), and the same shape as RISK-7's: something switches itself off with nothing printed.

Two things follow. For anyone writing a harness: **do not shorten a local-provider or auth-path run
with `API_TIMEOUT_MS`** — the obvious way to make it fast disables the path under test, and the run
then passes or fails for the wrong reason. For the design: a floor on `refreshDeadlineAt` (or a
`[Recovery]` line when the reserve eats the whole budget) would make it visible. Not changed here —
it is outside this brief and deserves its own validation.

## 2. The forbidden 503-with-no-banner state is bounded by `UI_LEASE_MS`, and that bound is 10 s

C-15a's first run killed the renderer 8.7 s before exhaustion and got a **503** with
`lastAckAgoMs: 9124, valid: true`. That is correct by the lease's own definition — a lease is valid
until `UI_LEASE_MS` after the last heartbeat, which is what makes it self-clearing on crash, EOF and
freeze with no cleanup path to forget. But it does mean the design's stated worst case, "we returned
a 503 and the banner never rendered", has a precise size: **a renderer that dies inside the last 10 s
of a hold still grants the retryable status.** Claude Code then re-asks, finds no pane, and that
request answers 400 — so the consequence is one extra round trip, not a silent hang. Worth knowing
before anyone tunes `UI_LEASE_MS` down and assumes the gate gets tighter for free; it is also why
`UI_HEARTBEAT_MS` must stay well under it.

## 3. Bun's `os.homedir()` ignores `$HOME`

Measured while building C-13: with `HOME` pointed at a scratch directory, `os.homedir()` still
returned `/Users/jack`. Anything keyed on `homedir()` — the config directory, `stats-buffer.json`,
the structural log under `~/.claudish/logs/` — therefore **cannot** be relocated by redirecting
`HOME`, and a test or harness that believes it has done so is asserting against the machine's real
state. C-13 grants stats consent through `setConfigFileOverride` instead and snapshots/restores the
real buffer, verified byte-for-byte. Relevant to CLAUDE.md's standing "guarded against touching the
real config" concern: `test:safe` guards the config file, and `homedir()` is the seam it does not
cover.

## 4. A killed session leaves its recovery socket directory behind, forever

`socket-server.ts:92` creates `/tmp/claudish-recovery-<24 hex>/` (0700, unguessable, `r.sock` inside
it), and `:111` removes it — from the owning process's own `teardown()`, and from nowhere else.
There is no sweeper. C-9 confirms the clean path works: the directory went at 30 076 ms, exactly
`PANE_LINGER_MS` after the episode closed. But a process that is SIGKILLed, crashes, or is cut short
by a `timeout(1)` cannot run its own cleanup, and nothing later reclaims what it left.

Counted on this machine after two days of building and validating the feature:

```
326 directories matching /tmp/claudish-recovery-*
  292 dated 11 Sep, 34 dated 12 Sep
  116 still containing a dead r.sock
```

Almost all of that is test debris — the unit suite, the harnesses, runs cut short by `timeout`. The
production equivalent is one directory per session that ends by SIGKILL or crash, which is rare per
user and unbounded over time. Each is tiny and `0700`, so this is hygiene rather than a security or
capacity problem; the names are unguessable and `O_EXCL` protects the file, so a stale directory
cannot be hijacked into the next run.

Two cheap options if it is worth closing: sweep `/tmp/claudish-recovery-*` older than a day at
startup (the same place the catalog cache is already maintained), or bind the socket under a single
per-user directory whose entries are reclaimed by name. Not done here — it is outside this brief, and
it wants its own decision about which process owns the sweep.
