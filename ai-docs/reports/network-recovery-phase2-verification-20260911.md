# Network recovery, design-Phase 2 — verification measurements

> Promoted out of the gitignored session directory deliberately, exactly as
> `network-recovery-phase0-measurements.md` was. CLAUDE.md records three write-ups already lost
> because they lived in `ai-docs/sessions/`, which does not survive a fresh clone or
> `git worktree remove`.
>
> Session: `dev-feature-network-recovery-20260910-110514-0ad0a5a0` · measured 2026-09-11 on macOS
> 25.6.0, bun 1.4.0. The per-file test inventory and the phase narrative stay in that session's
> `implementation-log-phase2b.md`; what is here is the evidence and the findings.

Phase 2 shipped the Tier-1 retry ladder with **no tests for any of its four new modules**. The suite
was green because the pre-existing tests had been opted out of the ladder with
`x-claudish-no-recovery` — not because the ladder had been verified. This is what verifying it
produced.

Suite: **3175 → 3271 pass**, 17 → 18 skip, **2 → 2 fail** (the two pre-existing `displayWidth`
Unicode-oracle cases, red on clean main under bun 1.4.0 while CI pins 1.3.10). +96 tests, zero new
failures. `typecheck` and `lint` clean.

---

## 1. The ladder's real gaps (C-2)

Real clock, real refused loopback socket, driven through `ComposedHandler.handle()` for the full
derived deadline. Deltas computed from the `[Recovery]` log timestamps:

| attempt | fires at | gap | ladder index |
|---|---|---|---|
| 1 | t+0 | — | 0 |
| 2 | t+5.002 s | **5002 ms** | 1 |
| 3 | t+15.004 s | **10002 ms** | 2 |
| 4 | t+45.009 s | **30005 ms** | 3 |
| 5 | t+105.010 s | **60001 ms** | 4 (clamped) |
| 6 | t+165.011 s | **60001 ms** | 5 (clamped) |
| 7 | t+225.012 s | **60001 ms** | 6 (clamped) |
| — | handoff at **t+225.018 s**, deadline 270 s | | |

Total drift over 225 seconds: **18 ms**. The schedule is `5 / 10 / 30 / 60 / 60 / 60`, and the last
array element repeating is what makes the sixth and seventh attempts happen at all — the DEADLINE
ends the ladder, not the array. That inverts `STREAM_RETRY_DELAYS_MS`, where the array running out
*is* the budget.

**`validation-criteria.md`'s C-2 text is stale and the implementation is right.** It says "six
attempts in total, with the handoff at t≈165s", derived for the superseded `TIER1_DEADLINE_MS =
180_000`. ADD-1 replaced that constant with a derivation that yields 270 000 ms at the default, and
270 s fits one more 60 s rung: **seven attempts, handoff at t≈225 s.** The gap sequence the criterion
headlines is unchanged.

---

## 2. F-SLOW fidelity, re-measured (ADD-2 and ADD-3 confirmed)

`192.0.2.1` is TEST-NET-1 (RFC 5737), unrouted **by convention** — a captive portal or an aggressive
corporate resolver can answer it, in which case every F-SLOW assertion passes for the wrong reason.
Checked before use:

| target | elapsed | outcome |
|---|---|---|
| `http://127.0.0.1:1/` (control) | **0.368 ms** | `TypeError` / `ConnectionRefused` |
| `https://192.0.2.1/v1` (F-SLOW) | **75005.18 ms** | `TypeError` / **`ConnectionRefused`** |

Both report the SAME CODE. **Slow and fast connect failures are indistinguishable by code on macOS;
only elapsed time separates them** — ADD-2, reproduced independently. Any logic that branches on the
code to tell "slow unreachable" from "fast refused" is wrong on this platform.

Phase 0 measured the OS give-up at 75.004 s; this machine, a day later, 75.005 s. That stability is
what makes ADD-3 binding: a `PER_ATTEMPT_CONNECT_CAP_MS` of 75 000 races the operating system by
**four milliseconds**, and which one wins is decided per run.

## 3. The per-attempt clamp against that fault

Real clock, real hung connect, the ladder's own clamp:

```
[F-SLOW live] attempt 45.001s (cap 45s, macOS gives up at 75.004s) · total 50.005s · exhausted
```

The attempt ended at **45.001 s** — a 30-second margin under the OS's 75.005 s — and the whole
episode finished at 50.005 s inside a 60 s budget, `exhausted` rather than overrun. The clamp's own
abort re-classifies as a failed attempt of the same kind (a `DOMException` named `TimeoutError`,
whose `code` is the NUMBER 23, which is why the classifier had to match on `name`) rather than
escaping the ladder as an unrelated error.

---

## 4. Mutation proof: 23 mutations, 23 killed, 0 survivors

Each mutation reverts ONE property, runs the tests that claim to pin it, and restores **by file
copy — never git**, because the stash stack and the index are shared with the main checkout and
every sibling worktree.

Killed: the repeating last delay · the `API_TIMEOUT_MS` derivation · the deadline floor · the
shortened-hold notice · one-timer-per-episode · waiter-deadline isolation · the Observer unsubscribe ·
rejoin keeping its ladder position · ladder-advance-per-round · the deadline bounding the attempt
*after* the sleep · the per-attempt clamp · client-disconnect detection · re-classification on every
attempt · signal composition · the shared inbound deadline anchor · the `x-claudish-no-recovery` gate ·
`probe-live` sending that header · the `CLAUDISH_RECOVERY` master switch · the success-only health
latch · the `{ cause }` carrying local connect evidence · the `loadConfig` allowlist entries · `{}`
meaning "no opinion" in the scoped reader · the injectable clock.

---

## 5. Two traps for whoever writes the Phase-3 tests

### 5.1 The debug-log buffer is flushed against `logFilePath` AT FLUSH TIME

`logger.ts`:

```ts
function flushLogBuffer(): void {
  if (!logFilePath || logBuffer.length === 0) return;   // early return…
  appendFile(logFilePath, logBuffer.join(""), …);       // …KEEPS the buffer
}
```

The early return does not clear `logBuffer`. Lines pushed while log file A was installed, but not yet
flushed when `logFilePath` became null, are appended to log file B the moment one is created — so a
test file's trailing log lines surface inside the NEXT file's capture.

Symptom, and it is the expensive shape: **an assertion that passes alone and fails in the full
suite.** Harmless in production (one log file per process), so the fix belongs in the test helper —
stamp a marker through the same FIFO buffer at capture start and read only what follows it. See
`packages/cli/src/recovery/test-helpers/capture-log.ts`.

### 5.2 Two different `[Recovery]` lines contain the substring `recovered after`

`withConnectionRetry` writes `… recovered after N attempts …`; `closeEpisode` writes
`… closed: recovered after …ms …`. A loose `includes("recovered after")` counts one recovery twice.
Any assertion about recovery counts — and C-17's assertion 3 is exactly one — must use the two
distinct patterns.

---

## 6. One recorded deviation from a criterion's literal text

C-17 assertion 4 requires the `[Recovery]` lines to name `…/api/tags`. They name `…/v1/models`:

```
[Recovery] episode f04bc428-… opened for Ollama at http://127.0.0.1:53801/v1/models (refused/ConnectionRefused)
```

`checkHealth()` probes `/api/tags` first and falls back to `/v1/models`, overwriting `lastProbeUrl`
each time, so what is reported is the LAST probe attempted. That is the more general behaviour — LM
Studio and vLLM have no `/api/tags` at all, so pinning the first would name a URL those providers
never touch — and it satisfies what FR-5 actually requires: the right HOST, and a probe path rather
than the inference path. The test is written to the requirement rather than to the example.
