# Network recovery, design-Phase 3 — the recovery pane, measured

> Promoted out of the gitignored session directory deliberately, exactly as
> `network-recovery-phase0-measurements.md` and `network-recovery-phase2-verification-20260911.md`
> were. CLAUDE.md records three write-ups already lost because they lived in `ai-docs/sessions/`,
> which does not survive a fresh clone or `git worktree remove`.
>
> Session: `dev-feature-network-recovery-20260910-110514-0ad0a5a0` · measured 2026-09-11 on
> macOS 25.6.0, bun 1.4.0, `magmux 0.11.0 (8ce5ef8)`. Baseline commit `343e35e`.

Phase 2 shipped the tier-1 retry ladder. Phase 3 gives it a face: a magmux pane claudish owns, a
versioned NDJSON link between the two processes, and the **lease** that will decide, one phase from
now, whether an exhausted episode may answer a retryable status. **Nothing here changes a status.**
The lease is computed and logged only — shipping the 503 flip before the banner exists would
recreate the buried-reason bug this feature exists to kill.

Suite: **3271 → 3331 pass**, 18 → 18 skip, 2 → 2 fail (+60 tests, zero new failures). The two are the
pre-existing `displayWidth` Unicode-oracle cases in `tui/viz/color.test.ts`, red on clean `main`
under bun 1.4.0 while CI pins 1.3.10. `typecheck` clean. **`bun run lint` now exits 0, which it did
not at `343e35e`.**

One run in the middle of this work showed a third failure — `fallback-handler.test.ts`'s
`kimi-k2.5 without prefix` at exactly 30 001 ms, a live-API call timing out under load. It passes
alone and passed on the next full run; it is the documented contention-flake class, not a
regression.

---

## 1. Two uncertainties, resolved before any production code

### U-4 — `open_pane`'s `split` is a 50/50 split, not a strip

One live `open_pane` against a headless magmux at `COLUMNS=120 LINES=40`, `list` before and after:

```
before:  {"pane":0,"cols":120,"rows":40,"state":"running"}          ← the whole terminal
after:   {"pane":0,"cols":120,"rows":20,"state":"running"}          ← HALVED
         {"pane":1,"control":true,"hidden":true,"state":"panel"}
         {"pane":2,"cols":120,"rows":19,"state":"running","cmd":"/bin/zsh -l -c …"}
```

There is no strip option in the protocol. **The architecture's stated fallback is taken: accept
50/50 for the outage's duration.** Claude Code handles SIGWINCH, and the pane is closed again when
the last episode ends.

Two further facts from the same capture, both load-bearing:

1. **The opened pane is index 2, not 1.** magmux's control panel occupies index 1 — its own help
   says "magmux's own panes are appended after them, whether or not `-c` was passed". The index is
   read from the `open_pane` reply (`{"id":1,"ok":true,"result":{"pane":2}}`) and never assumed.
2. **`cmd` really does run through the login shell** — `"/bin/zsh -l -c …"`, verbatim. RISK-5 is not
   hypothetical, so the launcher script is required rather than defensive.

### U-6 — magmux answers OSC 11, so theme detection works inside the pane

A probe run AS a pane command, in a headless magmux with no terminal behind it at all:

```
stdin.isTTY=true stdout.isTTY=true
TERM=screen-256color TERM_THEME=light MAGMUX_THEME=light COLORFGBG=15;0
MAGMUX_SOCK=/tmp/magmux-osc11probe.sock
RESULT: reply="\x1b]11;rgb:efef/f1f1/f5f5\x07" len=24
```

magmux synthesises the reply itself, so the bounded OSC 11 query in `theme-mode.ts` resolves inside
a pane — and outranks the `COLORFGBG=15;0` it also inherits, which would have said *dark*: the exact
lie `theming.md` demoted `COLORFGBG` for. Safe either way, because the banner's fill is deliberately
theme-independent (self-contained mid-dark red + bright-white ink, the `team-grid.ts` precedent), but
now known rather than assumed. `MAGMUX_SOCK` is confirmed exported to children.

---

## 2. The pane, live — C-3, C-4, C-5

Everything below `installRecoveryUi` in the harness is production code: the real coordinator, the
real UI manager, the real socket server, the real `claudish recovery-pane` process launched by
`open_pane`, inside a real magmux. The harness supplies only the two ends — a genuinely refused
endpoint and a stand-in for the Claude Code pane.

**On capture.** magmux's control socket has no screenshot command — `snapshot`, `screenshot` and
`capture` were each tried live and none returns pane text — and this session had no access to the
terminal plugin's `mux` MCP tools. So magmux was given a real PTY and its byte stream replayed
through a small VT grid (`phase3/vt.ts`), which is how a terminal produces a screen in the first
place. What follows is that grid.

### C-3 — the red banner, with provider, host and reason

```
CLAUDE CODE (stand-in) — this pane is the session
────────────────────────────────────────────────────────────────────────────────────────────────────
  ██ NETWORK · Live-probe refused
  Cannot connect to Live-probe at http://127.0.0.1:53999/v1/messages. Make sure the server is
  running.
  host 127.0.0.1:53999 · ConnectionRefused · local
  next attempt in 2s · attempt 1 · 3s in recovery
  last: ConnectionRefused · 1 request held
  click here or Ctrl-G Tab, then [r] try now · [q] give up
```

The sentence is `buildConnectionErrorMessage`'s own, verbatim — the same words the inline 400 would
have carried. If those two ever diverge, the user is being told two different stories about one
fault.

### C-4 — the countdown is live

Two captures four seconds apart, during the 30-second rung:

```
  next attempt in 28s · attempt 3 · 17s in recovery     ← A
  next attempt in 24s · attempt 3 · 21s in recovery     ← B, +4s
```

### C-5 — `[r]` collapses the wait

`focus` the recovery pane over the control socket, then one `r` into magmux's PTY:

```
[Recovery] attempt 4 (manual) for episode b6475bcd-…
[Recovery] Live-probe attempt 4 failed: ConnectionRefused (episode b6475bcd-…, ladder 3)
```

Keypress → attempt: **1 ms**, against a scheduled wait that still had **23 s** to run. The banner
then shows the next rung, `next attempt in 57s`, and a transient `retrying now…`.

The full episode log for that run, which also shows the pane attaching and the lease being granted:

```
[Recovery] episode b6475bcd-… opened for Live-probe at http://127.0.0.1:53999/v1/messages (refused/ConnectionRefused)
[Recovery] Live-probe attempt 1 failed: ConnectionRefused (…, ladder 0)
[Recovery] Live-probe waiting 5s before attempt 2 (…, 1 waiting)
[Recovery] socket listening at /tmp/claudish-recovery-27799446dda0a9a875cee1f0/r.sock
[Recovery] recovery pane opened (magmux pane 2) at /tmp/claudish-recovery-…/r.sock
[Recovery] pane connected (pid 68812, protocol 1)
[Recovery] pane is painting episode b6475bcd-… — lease granted (paneOpen=true)
[Recovery] Live-probe attempt 2 failed: ConnectionRefused (…, ladder 1)
[Recovery] Live-probe waiting 10s before attempt 3 (…, 1 waiting)
[Recovery] Live-probe attempt 3 failed: ConnectionRefused (…, ladder 2)
[Recovery] Live-probe waiting 30s before attempt 4 (…, 1 waiting)
[Recovery] attempt 4 (manual) for episode b6475bcd-…
[Recovery] Live-probe attempt 4 failed: ConnectionRefused (…, ladder 3)
[Recovery] Live-probe waiting 60s before attempt 5 (…, 1 waiting)
[Recovery] client gone during wait (episode b6475bcd-…)
[Recovery] episode b6475bcd-… closed: client_gone after 25412ms and 4 attempts
```

**The pane opens 4 ms after the episode does, and is painting 115 ms after that.** The socket path
carries 96 bits of randomness rather than the proxy port, which is printed at startup.

---

## 3. C-7 — the healthy request path, against `343e35e`

Measured where the request path lives: `ComposedHandler.handle()` against a REACHABLE upstream — a
real `Bun.serve` speaking real SSE over a real socket — timed to the first byte of the response
body. 40 samples each, after 10 warm-up calls. The `343e35e` column is a second worktree checked out
at that commit, running the same benchmark file.

| | median | p90 | min |
|---|---|---|---|
| `343e35e` (the phase-2 baseline) | **0.618 ms** | 5.047 ms | 0.367 ms |
| phase 3, recovery UI not installed | **0.627 ms** | 1.835 ms | 0.347 ms |
| phase 3, recovery UI installed | **0.448 ms** | 3.423 ms | 0.307 ms |

Δ median vs the baseline: **+0.009 ms** and **−0.170 ms** — both inside the run-to-run spread. That
is what the structure predicts: the only thing phase 3 adds to a request is one `uiLeaseValid()` call
**inside the exhaustion arm of a catch block**, which a healthy request never enters.

**What this does NOT measure: a real provider.** No local model server was running and the sandbox
had no credentials, so the upstream is a stub. The stub exercises the whole handler — adapters,
stream parser, response construction — and differs from a real provider only in network latency,
which is common to both columns.

## 4. C-16 / C-7's separate half — the magmux launch overhead

Spawn to the child's first frame, wrapped versus direct, 7 samples each, with a stand-in for Claude
Code so the number is the wrapper's cost and nothing else:

| | median | p90 | min | max |
|---|---|---|---|---|
| direct (login shell only) | 39.4 ms | 55.4 ms | 33.8 ms | 55.4 ms |
| wrapped in magmux | 136.2 ms | 179.4 ms | 131.4 ms | 179.4 ms |

**Δ median: 96.8 ms.** The bar is 500 ms; above 1 s revisits default-on. Phase 0 measured +107 ms
median on the same machine for the same thing, so this reproduces to within 10 ms.

**magmux's own exit status does not carry the pane's** — measured: pane 0 exited 42 while magmux
stayed alive waiting for a second pane. It does announce the death on the control socket
(`{"type":"exit","pane":0,"exitCode":42}`), so that event is the authority for Claude Code's exit
code, and it is also what lets the recovery pane be closed the instant Claude Code is gone rather
than after its linger — which matters because `-w` waits for EVERY pane.

---

## 5. C-8 — the precedence matrix, one real process per row

`flag > env > project > global > true`, nine rows, a fresh process each (the flag layer is module
state and the config readers hit real files, so two rows in one process would test the leftovers of
the first). `HOME` is redirected per row, so nothing reads or writes the user's own configuration.
Each row reports both what the switch resolves to and what it causes — whether a magmux wrap plan is
built — because a switch is only meaningful through its effect.

| flag | env | project | global | `resolveRecoveryUi()` | magmux wrap built | expected |
|---|---|---|---|---|---|---|
| — | — | — | — | **true** | true | true |
| — | — | — | `{"enabled":false}` | **false** | false | false |
| — | — | — | `{"enabled":true}` | **true** | true | true |
| — | — | `{}` | `{"enabled":false}` | **false** | false | false |
| — | — | `{"enabled":false}` | `{"enabled":true}` | **false** | false | false |
| — | `0` | `{"enabled":true}` | — | **false** | false | false |
| — | `1` | — | `{"enabled":false}` | **true** | true | true |
| `--recovery-ui` | `0` | `{"enabled":false}` | `{"enabled":false}` | **true** | true | true |
| `--no-recovery-ui` | `1` | — | — | **false** | false | false |

All nine pass. Row 4 is the one worth having: a project file carrying `"recoveryUi": {}` means **no
opinion** and falls through to the global scope rather than reading as `true`. That is why the config
field is an object rather than a bare boolean, and it is invisible to any test that only writes
`true`/`false`.

---

## 6. The lease — the round-2 CRITICAL, and the test that can fail on it

The rule: *a retryable status is permissible exactly while claudish still has a surface on which the
reason is legible.* The superseded design renewed that lease from **frame receipts**, and frames
ticked only while the ladder was `waiting`. A connect against an unreachable host takes 20–75 s
(measured on this machine: `192.0.2.1` = 75 005 ms), during which the proxy has nothing new to say —
so the lease died ten seconds into every slow attempt, and the exhaustion arm, which reads it
immediately after an attempt returns, saw it false for the **entire failure class the feature was
built for**, with a live painted banner on screen. Every test passed, because every fault in the
suite was a ~1 ms loopback refusal.

What ships instead:

```
uiLeaseValid(id)  ⇔  paneOpen (WE opened it, and hold the open_pane reply)
                  ∧  some client heartbeated `ack` naming THIS episode within UI_LEASE_MS
```

- **granted by an `ack` sent AFTER PAINTING**, not on frame receipt;
- **renewed by the renderer's own 1 Hz timer**, independent of frame arrival;
- **revoked** by `bye`, by socket EOF, by a killed or frozen pane — all through one expiry path;
- **`paneOpen` is required**, so a forged same-uid client cannot manufacture the forbidden state.

Two tests exist specifically to fail on the old behaviour:

1. *unit, fake clock* — 45 seconds of attempt, 4.5 lease windows, **not one frame emitted**; the
   renderer heartbeats on its own timer and the lease holds throughout.
2. *end to end, real socket, real renderer* — the server sends exactly ONE frame (the replay) and
   then nothing, which is what a hung connect looks like on the wire. The real
   `claudish recovery-pane` still emits ≥3 acks and the lease is valid with the lease clock 20 s past
   that only frame. **Mutating the renderer back to ack-per-frame fails this test.**

Also pinned: the lease expires exactly `UI_LEASE_MS` after the last heartbeat; it is per-episode, so
heartbeating one grants nothing to another; switching the painted episode lets the old lease lapse
with no extra protocol; and `[q]` closes the pane so that no later heartbeat can resurrect anything.

---

## 7. Mutation proof — 21 properties, 21 killed

Each mutation reverts ONE property, runs the tests that claim to pin it, and restores the file **by
copy — never with git**, because the stash stack and the index are shared with the main checkout and
every sibling worktree.

Killed: replay-on-connect · the tick in every live state · the frame version gate · `hello` parsing
at the wrong version · the 0600 socket / 0700 directory · unlinking both on close · the countdown
reading the live clock · **the palette read at RENDER time** · `attempting` showing the connect
rather than a frozen countdown · the dead-proxy notice threshold · `q` sending `bye` · `r` sending
`retry_now` · clipping to the pane width · **only the deltas reaching disk** · the launcher script's
0600 mode · **exporting AFTER the profile** · stripping `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` ·
the no-nesting gate · the interactive + TTY gate · `--id` / `--no-idle-done` / `-w` / `--no-status` ·
`MAGMUX_SCROLLBACK` never overriding the user. Plus the four lease mutations above, run separately.

One near-miss worth recording: `writeFileSync(..., { mode: 0o600 })` and the `chmodSync` that follows
it are **both** present, and only the chmod is observable — `mode:` is subject to the umask, so
mutating it alone leaves the final mode correct. `mode:` still earns its place (it closes the window
between creation and chmod during which the file would be world-readable), but no assertion on a
finished file can see a race, so it is documented rather than pinned.

---

## 8. Three things found while building, none of them in the plan

### 8.1 A `team --grid` slot would have wrapped a second magmux inside its own pane

`team --grid --mode interactive` launches one `claudish --model X -i` per pane. Each of those IS
interactive with a real TTY, so the wrapper's stated gate (`interactive && stdout is a TTY && the
binary resolves`) is satisfied in every slot — and each would have started its own magmux **inside
the pane it was already running in**. N nested multiplexers, each with its own control socket and its
own idea of the layout.

magmux exports `MAGMUX_SOCK` to its children precisely so a child can tell. The wrapper now returns
null when it is set, and `claude-runner` installs the recovery UI against that **ambient** socket
instead. The cross-process `O_EXCL` lock then keeps the grid to ONE banner: the winner serves it, the
losers still retry and still recover, hold no lease, and answer inline at exhaustion — which is
exactly what the biconditional requires.

### 8.2 The pane command must be built from `process.argv`, and the first attempt proved why

`recoveryPaneCommandLine()` builds `<runtime> <script> recovery-pane --socket <path>` from
`process.argv`, which is correct in production because `argv[1]` IS claudish's entry point. The first
live run had `argv[1]` pointing at the harness, so the pane **re-launched the harness** — it printed
"waiting for magmux…" into the banner's pane and left a directory of captures named `recovery-pane/`
in the repo root. The failure mode is precisely the one the builder exists to avoid (a pane that is
not this build), and it is loud rather than silent, which is the good news.

### 8.3 A split pane is half the terminal, so every line is clipped to its width

Following from U-4: the banner is rendered into a pane that may be 40 columns wide. Every line now
goes through one clipping step that steps OVER the escapes — `String.length` counts an SGR sequence
as eight or nine characters and would cut a line mid-escape, leaving the rest of the pane painted in
whatever colour the fragment started. Below 64 columns the key hint sheds the part a user can work
out (where to click) and keeps the part they cannot (which keys exist).

---

## 9. What is NOT verified, and why

- **C-7 against a real provider.** No local model server was running and the sandbox has no
  credentials; the measurement above uses a stub upstream through the real handler. The stub differs
  from a provider only in network latency, which is common to both columns.
- **C-16's Ctrl-C and exit-code propagation in a real terminal.** The exit-code path is implemented
  from the measured `{"type":"exit","pane":0,"exitCode":42}` event and unit-tested at the plan level,
  but driving a real Ctrl-C into a real attached terminal needs a TTY this session does not have.
  The `[Claude Code] Exited…` structural log line is unchanged code on an unchanged path.
- **C-6, C-12, C-14, C-15, C-17, C-18, C-19.** Not in this phase's scope. C-18's lease half is
  covered by §6 — the lease is logged at exhaustion (`ui_lease=…`) rather than acted on, one phase
  before it can cost anything.
