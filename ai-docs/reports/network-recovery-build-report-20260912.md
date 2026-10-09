# Build Report — Network-error recovery

**Session**: `dev-feature-network-recovery-20260910-110514-0ad0a5a0`
**Mode**: Full depth · Autonomous
**Branch**: `worktree-recover` · **Baseline**: `3c1fa26` · **HEAD**: `1e87ae6`
**Outer loop**: 1 iteration, Phase 7 PASS at 95%

---

## 1. What was asked, and what shipped

The request: when a network error kills a Claude Code session, claudish should recover instead of
leaving it stuck forever. Show a red banner, a manual "try now", and a countdown with escalating
retry timing. The originating incident:

```
API Error: 400 Cannot reach Openai-codex at https://chatgpt.com/backend-api/codex/responses.
Check your network connection.
```

Ten tasks in flight; all stopped. The same fault reproduced **eight times during this build**,
killing five subagents and two review sessions — so the premise needed no defending.

**What ships** is a two-tier recovery:

| Tier | Behaviour |
|---|---|
| 1 — in-request | Retries the upstream on a 5s/10s/30s/60s/60s… ladder inside a deadline **derived from `API_TIMEOUT_MS`** (≈270s at defaults), holding the client request open. |
| 2 — across requests | On exhaustion, answers **503** so Claude Code re-asks, and the re-ask **rejoins the same episode** — one countdown, one attempt counter, one episode id. |
| The pane | A magmux pane claudish owns, showing the banner, live countdown, `[r] try now`, `[q] give up`, and counters — spanning both tiers. |

Demonstrated end to end on a real session: **handoff at t+233s, server started at t+248s, turn
answered with a real model answer**, `rejoined … client retry 1, ladder 6, attempts 14`, one episode
id across three client requests.

### Where the ask was not met literally

**FR-3 said "retry forever, no wall-clock cap."** No single held request can outlive the client's own
ceiling — Phase 0 measured that ceiling at **359.607s**, reproduced six times, and proved it is
`API_TIMEOUT_MS`'s *default* rather than a fixed watchdog. So the **mechanism** departs: recovery
spans requests instead of living inside one. The **magnitude** largely does not — with the watchdog
the user restored, reach is ~300 client attempts, on the order of a day. Recorded in
`requirements.md`.

---

## 2. Requirements

| Req | Status | Note |
|---|---|---|
| FR-1 reclassify all four connection kinds | **Met as written** | The carve-out was deleted on user decision after failing review twice |
| FR-2 backoff 5/10/30/60/60… | **Met** | Single exported constant; C-2 verified at three different deadlines |
| FR-3 unbounded budget | **Amended** | Per-request deadline + client re-entry; see §1 |
| FR-4 hold the request open | **Amended** | Held to the deadline, then handed back into the same episode |
| FR-5 recovery UI | **Met** | Banner, countdown, `[r]`, `[q]`, counters |
| FR-6 three switches | **Met** | flag > env > project > global > true; 20/20 precedence matrix |
| FR-7 stats | **Exceeded** | Retry attempts, recovery ms, **plus** an episode id for cross-request attribution |
| NFR-1 healthy path untouched | **Met** | +0.414 ms p50 against a live provider, mean −0.030 ms |
| NFR-2 resource safety | **Met** | Disconnect exits in 303 ms, 0 orphans |
| NFR-3 terminal isolation | **Met** | Pane owns its own PTY |
| NFR-4 status-remap discipline | **Met** | Verified in review; no raw `status ===` added downstream of the remap |

### User decisions

| Decision | Chosen |
|---|---|
| Retry reach | Watchdog **restored** — ~a day, ~2,100 worst-case attempts/turn, RISK-6 accepted at ~30× |
| ECONNRESET/EPIPE | **Retry unboundedly** — duplicate-charge exposure accepted, mitigated by visibility |
| Loopback carve-out | **Deleted entirely** — "we are not building a solution for ollama, it is a general one" |
| Phase 1 | Ships with the feature, not as a separate PR |

Two orchestrator provisional calls (carve-out re-keying, watchdog dropped) were **overridden by the
user** once the measured arithmetic was in front of them.

---

## 3. What the process found

This is the part worth keeping. **Fourteen defects**, at five different stages, most invisible to the
stage before.

### Design review (3 rounds: 8 CRITICAL → 1 → 0)

- **429 would have been a live billing bug.** `fallback-handler.ts:246` returns true for 429, so the
  chain would advance mid-outage — off a subscription onto metered. 503 has no such branch.
- **The `uiAttached` latch was never cleared**, so `[q] give up` produced a silent 503 spinner.
- **The 240s budget started at the wrong clock**, overrunning Bun's 255s `idleTimeout`.
- **Local providers never reached the ladder at all** — `local.ts` swallowed the connect error — and
  the validation plan structurally could not detect it, because its fault used a custom endpoint on a
  different transport.

### Phase 0 measurement

- **`API_TIMEOUT_MS` is a user-settable knob the design never read.** A user with it below ~300s
  would silently get `client_gone` on every episode. The deadline is now derived.
- **Claude Code's retry budget is a COUNT (~11 attempts), not a duration** — six replications.

### Code review (2 rounds: 7 HIGH → 0)

- **A fired `AbortSignal.timeout` was reused by every retry**, so for `vx@` Tier 1 made *zero* real
  connect attempts past t+30s while logging attempts that never left the process. Proved by executing
  Bun, not by reading.
- **`TimeoutError` classification pulled a transport's own inference ceiling into the ladder**,
  converting a slow thinking-model turn into ~300 billed re-inferences. Outside what the user priced.
- The launcher script held `ANTHROPIC_API_KEY` deltas at a predictable path.

### Black-box testing — the highest-yield stage

Tests written from the requirements by an agent that never read the implementation found **four
defects that 3396 implementation-side tests and five review rounds had all missed**:

- **The chain-safety guarantee was structural in one arm only.** The marker that neutralises the
  quota-wording check is minted on the **503** arm; when exhaustion answers **400** (no banner —
  *every headless run*), the wording check decided again and an unreachable host whose error text
  contained "quota" **advanced the chain**. Round 1's own C-12 quota test had passed — on the 503 arm.
- A client re-ask was abandoned once the carried rung outgrew the deadline (any `API_TIMEOUT_MS ≤ 90s`).
- A slow connect outlived the deadline — measured 110s on a 30s budget.
- `[Recovery]` lines were file-only, so a 4½-minute headless hold showed the user **nothing**.

### Real validation

- **`--no-recovery` still paid for the magmux wrap** — a MEDIUM the orchestrator had filed as
  non-blocking follow-up, promoted to a FAIL by an actual launch.
- **C-11's own criterion was unmeetable**, written without a control: both builds sit at a ~2.1s floor.

---

## 4. Implementation

**76 files changed, +17224 / −236.** 14 new source modules, 25 new test files.

| Area | Modules |
|---|---|
| Retry core | `handlers/shared/transient-retry.ts`, `recovery/coordinator.ts`, `recovery/clock.ts` |
| Chain safety | `handlers/shared/recovery-marker.ts` |
| Pane | `recovery/pane-app.ts`, `socket-server.ts`, `socket-client.ts`, `types.ts`, `magmux-ui.ts` |
| Launch | `launcher/magmux-wrapper.ts`, `launcher/magmux-binary.ts` |
| Config | `recovery/settings.ts` + `profile-config.ts` wiring |

**Commits** (7 signed, 3 unsigned — see §6):

```
52f52e6 G  fix(handlers): stop a network outage from advancing the fallback chain
6402988 G  wip(recovery): Tier-1 retry ladder, tests not yet updated
9311dbc G  test(recovery): restore the suite to baseline after the Tier-1 ladder
343e35e G  test(recovery): verify the Tier-1 ladder, which shipped with no tests at all
4bd5248 G  feat(recovery): give the retry ladder a face — the magmux recovery pane
1f4f3ce G  feat(recovery): hand the retry back to the client when the reason is legible
993047e G  feat(recovery): count the outages, and write down why the shape is what it is
8ed0f13 N  fix(recovery): stop the ladder faking attempts, billing latency, and ignoring [q]
60cdb37 N  fix(recovery): make the budget, the chain guard and the log real in the arm nobody tested
1e87ae6 N  fix(recovery): stop --no-recovery paying for a pane it can never open
```

A latent bug fixed on the way: **a network failure wearing an auth status code at five sites** in
`composed-handler.ts`. 401 is retryable to `FallbackHandler`, so an outage during a token refresh
walked users across providers and off their subscription. All five now route through one
`respondConnectionError`.

---

## 5. Verification

**Suite: 3451 pass / 18 skip / 2 fail.** Both failures are `displayWidth` oracle tests, **reproduced
at `3c1fa26`** — pre-existing, not from this work. `typecheck`, `lint`, `format` all exit 0.

All nineteen criteria demonstrated at HEAD with captured evidence, including the four non-waivable
ones:

| Criterion | Evidence |
|---|---|
| **C-6** recovery completes the turn | Two real sessions; tier-1 at t+53s, tier-2 handoff t+233s → server t+248s → answered. One episode id across three requests |
| **C-12** no chain advance | 400 arm, quota variant: `hasQuotaExhaustionWording` **true** on the real body, zero advance |
| **C-17** local transport | 16 probes while down, exactly 2/attempt, `recovered` only after the server returned |
| **C-18** slow fault → 503 | `192.0.2.1` at 75006 ms; lease `lastAckAgoMs` ≤203 ms across every clamped attempt |
| C-2 ladder shape | Gaps 5/10/30/60/60/60 at **three** deadlines — proving derivation, not a hardcoded count |
| C-7 healthy path | Live ollama, interleaved A/B: **+0.414 ms p50**; magmux launch +89 ms, reported separately |

Mutation testing throughout: every significant fix was proved by reverting it (by file copy, never
git) and observing the test go red. **One mutation survived and was reported as such** rather than
hidden — it led to documenting four disjoint abort windows.

---

## 6. Known issues and follow-up

**Immediate:**

1. **Three commits are unsigned** (`8ed0f13`, `60cdb37`, `1e87ae6`). `git commit` failed with
   `1Password: failed to fill whole buffer` — the Mac was locked and the signing key unreachable.
   Signing config was never altered. Re-sign with:
   `git rebase --exec 'git commit --amend -S --no-edit' 993047e`

**Pre-existing, outside this change:**

2. **`openai-codex.ts:63-70` swallows a refresh network failure and falls through to the METERED
   `api.openai.com` path.** A sixth instance of the auth-status class, and the worst-shaped: nothing
   throws, so recovery can never engage. Deserves its own fix.

**Found during validation, not blocking:**

3. `API_TIMEOUT_MS ≤ 75000` puts the auth-path deadline in the past, so a stopped local server
   silently loses recovery.
4. A SIGKILLed session never reclaims `/tmp/claudish-recovery-*` — **326 stale sockets** on this
   machine.
5. The 503-without-banner window is exactly `UI_LEASE_MS`.
6. Bun's `os.homedir()` ignores `$HOME`.
7. Two `MEDIUM` review findings remain open: an abandoned auth op re-entering Grok's single-flight
   promise, and the watchdog's pane gate passing for every `ambient` claudish.

**Process note:** external review models failed **five times across three vendors** during this
build, every one a network fault rather than a review failure. The code review verdict therefore
rests on **one graded review** plus one truncated corroborating read — stated in the consolidation
rather than presented as consensus.

---

## 7. Recommended next steps

1. **Re-sign the three commits** (one command, above).
2. **Open the PR.** The branch is green, reviewed and validated.
3. **Fix `openai-codex.ts` separately** — it is a real billing exposure and independent of this work.
4. **Install and run it for a week.** Eight network faults hit this machine during the build; the
   feature's value shows up in ordinary use, not in a test.
5. Consider a `/tmp/claudish-recovery-*` sweep on startup (item 4 above).
