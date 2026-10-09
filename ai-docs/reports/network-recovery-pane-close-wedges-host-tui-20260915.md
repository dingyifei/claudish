# Closing the recovery pane wedges Claude Code's renderer

**Found**: 2026-09-15, by the user, looking at a real session after the live demo.
**Status**: RESOLVED 2026-09-23. The pane is gone: the banner is magmux's own `overlay` on the
pane Claude Code already occupies, so nothing reflows (§9). Verified live in a 214×29 pane — the
`❯` composer sat on row 26 during the outage, at the recovered banner, and after the overlay
cleared, and typed text landed in it — see `network-recovery-overlay-validation/`.
**Branch**: `worktree-recover`, found at `8aaa270`, fixed in `b26d0a76`.

---

## 1. The symptom

After a recovery episode ends and the pane closes itself, the host session is left with:

- no visible input box,
- the status line stranded part-way up the screen,
- every row below it dead,
- six rows of bottom chrome collapsed onto one line.

Typing still registers, but the characters are painted **on top of** the status line, so the
session is usable only blind.

---

## 2. Measured, in one 190x64 pane, 27 seconds apart

`tmux capture-pane -p` with row numbers, same pane, before and after the pane closed itself.

**Before (01:23:44) — correct:**

```
27                                                       27650 tokens
28  ──────────────────────────────────────────────────────────────────
29  ❯
30  ──────────────────────────────────────────────────────────────────
31    * recov@recov-model | $0.14 | 2m2s | 󰍛 400M | ░░░░░░ 14% • Recov • ~$0.028 • 27k tokens
32    ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
33  ──────────────────────────────────────────────────────────────────
34    ██ NETWORK · Recov recovered
35    9 attempts over 2m 11s
36    this pane closes on its own
```

**After (01:24:11) — wedged:**

```
32  ──⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents Recov • ~$0.028 • 27k tokens────
```

Rows 24-31 blank. Rows 33-64 blank. The composer, both separator rules and the model status
line are gone; what is left is one line carrying fragments of three of them.

---

## 3. It is NOT a missing resize

Measured immediately after the close:

```
Claude Code pty (ttys020):   64 190
tmux pane %347:              190x64
```

magmux handed pane 0 the entire terminal and resized its PTY, which delivers SIGWINCH. Claude
Code has all 64 rows and paints its chrome at row 32 anyway.

---

## 4. It is NOT an artifact of a nested multiplexer

Reproduced on a bare PTY with no outer tmux — a user's own terminal — via
`post-close-render.ts` (§8), which drives the real branch build behind
`phase3/pty-host.py` and models the screen with `phase3/vt.ts`:

```
rows                     : 44
last painted row         : 21
blank rows below it      : 22
composer (input box) up? : false
RESULT: BROKEN — chrome stranded / no input box after the pane closed
```

Final screen, same merged line as the user's own screenshot:

```
──⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents Recov • ~$0.028 • 28k tokens──────
```

---

## 5. It cannot be repaired from outside

Each tried against the wedged session, each measured:

| Attempt | Result |
|---|---|
| `Escape` | no change |
| a printable keystroke | registers, but paints **over** the status line |
| `Ctrl-L` | clears the transcript, chrome stays stranded at the same row |
| `kill -WINCH` at the same size | no change (dimensions unchanged, so it is a no-op) |
| a real shrink-then-grow resize cycle | merged line moves one row; composer does **not** come back |

Once wedged, the session stays wedged until it is restarted.

---

## 6. Where it comes from

`recovery/magmux-ui.ts:428`:

```ts
async function closePane(): Promise<void> {
  if (state.control && state.paneIndex !== null) {
    await request(state.control, { type: "close_pane", pane: state.paneIndex, force: true }, 1_000);
  }
  await teardown();
}
```

`close_pane`, then claudish tears down its own socket state. Nothing else. It trusts magmux to
give the rows back — which magmux does, correctly (§3) — and trusts the host to repaint.

**Inference, not measurement:** the defect is in Claude Code's renderer handling a *grow*.
On shrink (the pane opening) it re-lays out correctly — every capture in §2 "before" and every
Phase-7 capture proves that. On grow it keeps the old anchor. claudish does not cause it, but
claudish is what triggers it, twice per outage, and claudish is what has to work around it.

---

## 7. Why eight phases of validation missed it

Every Phase-7 capture was taken while the pane was still **open**. `validation/c17/C-17-final.txt`
— the file named "final" — still contains:

```
  ██ NETWORK · Ollama recovered
  8 attempts over 1m 59s
  this pane closes on its own
```

The pane had not closed yet. C-1 checked continuously that `API Error: 400` never appeared, C-6
that the turn completed, C-3/C-4/C-5 that the banner painted — and all of them are satisfied by a
screen captured before `PANE_LINGER_MS` (30 s) expired. **No criterion looked at the screen after
the pane closed**, so the last state the user is actually left in was never observed.

This is the same shape as the Phase-6 finding that black-box tests caught what 3396
implementation-side tests missed: the tests all stopped at the moment the feature declared
success.

---

## 8. Repro

`post-close-render.ts`, kept alongside this report. Bare PTY, no outer multiplexer, real branch
build, real ollama answer, fault is F-REFUSED on a verified-free port. It captures the screen
while the pane is open, then again past the 30 s linger, and prints a verdict.

```
bun post-close-render.ts
```

---

## 9. The fix: magmux already has all of this, and we did not use it

The pane was never needed. magmux ships three primitives for exactly this display role, and
**none of them changes the layout**, so the trigger in §6 cannot occur:

| Need | magmux verb | Source |
|---|---|---|
| Banner box with reason, styled red | `{"type":"overlay","pane":0,"text":"…","style":"error"}` — centred box, border, drop shadow, `\n` for multi-line | `main.go:5736`, `main.go:1578`, `main.go:2395` |
| Live countdown / attempt counters | `{"type":"status","text":"…"}` — arbitrary status-bar text, and it force-redraws every pane | `main.go:5697` |
| Colour the session during an outage | `{"type":"tint","pane":"*","color":"red"}`, `"reset"` on recovery | `main.go:5709` |
| Dismiss | set the overlay text to `""` | `main.go:1867` |

Cost: the status bar is **1 row**, decided once by `statusRowsLocked` (`main.go:3145`); the overlay
costs **zero** rows — it is drawn over the pane. Claudish currently passes `--no-status`
(`launcher/magmux-wrapper.ts:276`), which switches the status bar off. That flag is the only one in
that argument list with no comment explaining it.

What claudish built instead: a second pane, an NDJSON socket server and client, a wire protocol, a
renderer process (`recovery/pane-app.ts`), and a lease/heartbeat scheme — reached through
`open_pane`/`close_pane`, which is what reflows the layout and wedges the host.

**Is it a magmux bug?** Examined and: no, not for this. `sockClosePane` (`sockrpc.go:579`) resizes
correctly — §3 measures the survivor's PTY as exactly the full terminal — and magmux cannot repaint
a child's content for it; only Claude Code can. magmux's own chrome toggles are safe, measured:
showing and hiding the control panel on a healthy session left the composer and both status lines
intact (`126 → 63 → 126` cols). The defect is Claude Code's repaint on a height grow, and the
remedy available to us is to stop causing a reflow at all.

Superseded: an earlier draft of this section proposed reserving rows up front or never closing the
pane. Both are workarounds for a pane that should not exist.

---

## 10. Impact

The retry engine is untouched — the turn still recovers, and §2's "before" capture shows a real
answer delivered. What is damaged is the session the user is handed back afterwards: on every
successful recovery with the pane enabled, they lose their input box and have to restart.

For a feature whose purpose is "do not make the user restart after a network error", that is a
blocker, not a cosmetic issue.
