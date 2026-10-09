> One detected theme for every surface, and the module-load palette-snapshot bug class it keeps producing.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Light/Dark Theme (auto-detected)

Every screen and every colored CLI line resolves through ONE detected terminal
theme. `theme/theme-mode.ts` is the sole authority — dependency-free (never
pulls OpenTUI into a plain CLI path) — with sources in precedence order:
`CLAUDISH_THEME=light|dark` (override; also the deterministic lever for tests
and screenshot harnesses) → a bounded **OSC 11 query** → `COLORFGBG`. The query
runs only when stdin AND stdout are OUR TTYs, so a piped/proxied claudish never
writes escapes into another program's stream. The three OpenTUI boots (config
TUI, probe TUI, resume picker) instead feed `renderer.waitForThemeMode(250)`
into the same state via `theme/renderer-theme.ts`, pre-first-paint.

## OSC 11 outranks `COLORFGBG` — because `COLORFGBG` lies (2026-08-22)

`COLORFGBG` used to come SECOND and short-circuit the OSC query entirely. It was
demoted on direct evidence from a real cream terminal inside tmux:

```
COLORFGBG="15;0"          → "dark"    (bg slot 0 = black)
OSC 11 reply, 19ms        → "light",  background #f9f6da
```

The terminal is genuinely cream. `COLORFGBG` is a HINT the emulator writes once;
it goes stale, and tmux inherits a stale value straight across a theme change.
Trusting it painted the dark palette onto a light terminal for every CLI surface
— while the TUI, which asks OpenTUI's own OSC handshake, correctly rendered
light. The two surfaces of one process disagreed about the same terminal.

An OSC reply is a MEASUREMENT, and it settles the mode and the colour together,
so those two can never contradict each other. `COLORFGBG` remains the fallback
for terminals that do not answer, and for `detectAndSetThemeModeSync`, which
cannot await.

**A frequent measurement trap:** a `create-headless` tmux server is DETACHED —
there is no terminal behind it to answer OSC 11, so every query looks like a
non-answer. Probing the theme requires a pane in an ATTACHED session. An earlier
pass concluded "tmux does not answer OSC 11" from a headless pane; tmux answers
in 19ms.

## The page colour is the terminal's own (`getTerminalBackgroundHex`)

The OSC reply's RGB used to be reduced to one light/dark bit and discarded, so
the TUI painted a hardcoded `#ffffff` / `#000000` page — the right CLASS, rarely
the right shade, and on a cream terminal a visible white slab with a seam at
every edge. `applyTuiTheme` now adopts the measured colour as `C.bg` when one is
known.

`C.bg` stays OPAQUE — it cannot simply be transparent, because the 1Password
add-wizard is an absolute overlay that relies on it to occlude the list beneath.
Matching the terminal exactly is how the page becomes invisible while remaining
opaque.

`bg` is adopted, and the NEUTRAL SURFACES move with it — `retintSurfaces`
transplants each one's per-channel offset from the palette's own page onto the
real one, so `bgAlt` on a cream terminal becomes a deeper cream rather than a
grey slab floating on it. `SURFACE_TOKENS` is that list, and it now includes the
quiet chip fills, which are near-background by construction (see the chip
section below).

`bgHighlight` / `bgError` and the SIGNAL fills stay from the palette: they carry
their meaning in their HUE, and re-tinting them would erase the signal they exist
to send. Safe by construction: the mode was classified from THIS colour's
luminance, so the palette's foregrounds were already chosen against it.

(`claudeup` in magus-src solves the same problem by painting no page at all —
"accents are chosen to clear 3:1 against both backgrounds, and body text uses
the terminal's own foreground". That is the cleaner answer where nothing needs
to occlude; claudish cannot take it while the modal depends on an opaque page.)

**Unknown resolves to DARK — the status quo, never a guess.** Every dark value
is byte-identical to what claudish always shipped (pinned by
`tui/theme-contrast.test.ts` snapshot equality); only a POSITIVE "light"
detection changes anything. That contract is why detection failing silently is
safe: it looks like yesterday's claudish, not like white-on-white.

**The palette is MUTABLE and everything derived must refresh.** `tui/theme.ts`
reassigns `C` in place on every mode change; derived palettes register via
`registerPaletteRefresher` (viz `tokens`/`ramps` re-snapshot there; `STAGE_BG`,
`STAGE_FG`, `STAGE_BG_ANSI`, latency buckets refresh in `applyTuiTheme`). The
recurring bug class this creates: **a module-level `const X = C.foo` (or
`tokens.foo`) snapshots the DARK value before detection completes** — command
modules are imported before detection runs. Found SIX times during the build
(resume-picker's `MUTED`/`SCROLLBAR`/calendar scale, session-summary's
`TOOL_COLORS`, conversation-reader's `BAR_COLOR`, and `STAGE_FG`, the last one
only visible in a live screenshot). The rule: read `C.*`/`tokens.*` at RENDER
time, or convert the constant to a function; plain CLI files call `cliAnsi()`
(`theme/ansi.ts`) INSIDE the command function, never at module load.

Token semantics that make one component tree serve both palettes: `C.ink` is
always white — ink on fills claudish paints that stay mid/dark in BOTH themes
(pills, latency chips, active tab); `C.strong` is emphasized text on the page
or on the light theme's selection WASH (`#bfdbfe`) — white on dark, near-black
on light. Never use `C.white` for page text. Light accents are deep and
saturated (all ≥4.5:1 on white, enforced by `theme-contrast.test.ts`, with the
same WCAG math as `resume-picker-contrast.test.ts`, which grades both chip
palettes).

CLI escapes: dark/unknown emits the CLASSIC 16-color codes (byte-identical to
the old hand-rolled blocks); light emits deep truecolor; `NO_COLOR` empties
everything — it was advertised as global in `--help` and is now actually
honored globally. The status-line scripts CANNOT self-detect (they run later
inside Claude Code), so `createTempSettingsFile`/`createStatusLineScript` bake
the detected mode at generation time. `team-grid.ts` banners are deliberately
theme-independent (self-contained mid-dark fill + bright-white ink pairs).

Testing gotcha: `setThemeMode` flips a process-global palette and Bun runs
sibling test files in one process — always restore (`resetThemeModeForTests()`
re-publishes `null`; it deliberately does NOT clear the listener registry,
which would freeze the palette for every later test file).

## A colour for a glyph is not a colour for an area (v9.0.8, `isLightTheme`)

`LIGHT`'s accents are chosen so TEXT clears 4.5:1 on white: `#1d4ed8`, `#dc2626`,
`#15803d`. That is the right test for a letter and the wrong one for a filled
region. The session summary card drew its meters as `█` runs in those same
hexes, which on a cream terminal read as slabs — Jack's words were "the colours
are too hard" and "the progress bars are too heavy, getting all the attention".

The fix is a rendering difference, not a palette change, so it needs to know
which palette is loaded. `theme.ts` now records the applied mode and exports
`isLightTheme()`; `session-summary.ts` wraps every large fill in `area()`, which
is `lighten(hex, 0.55)` on light and the identity on dark. Dark is deliberately
untouched: neon on true black is the btop look every other claudish surface
renders, and lightening there washes it out.

Call `isLightTheme()` at RENDER time. It is the same rule as `C.*` and it fails
the same silent way: detection runs after this module is imported, so a value
captured at module load is the pre-detection default forever.

Two related decisions in the same card, both about meaning rather than colour:

1. **Meters are capped at 30 columns**, not sized to the leftover width. Filling
   the leftovers made the charts grow with the terminal while the numbers stayed
   put, so on a wide window the card was mostly bar.
2. **The savings meter encodes the AMOUNT saved against the dearest baseline**,
   on the neutral `volume` ramp — not the fraction of its own baseline avoided,
   on the red-to-green `savings` ramp. The fraction is 100% for every row of
   every free session, so it drew two identical full gradient bars: the loudest
   mark on the card, carrying nothing. Measured against the dearest baseline the
   rows differ and the difference is the ratio between what those baselines
   charge. The percentage stayed, as text.

Prices are printed in body ink. Green is this palette's "ok", the figures are
facts rather than verdicts, and the FREE badge two rows above already says free
in colour.

## A chip is a CONSTRUCTION, and the page picks which one — superseded, 2026-09-12

**This section replaces the one that preceded it, which is kept below the rule as
the measurement that forced the change.** The old rule was: one hex per chip,
measured against BOTH `CONTRAST_REFERENCE` pages at 3:1, carrying white `C.ink`.
It is gone. What replaces it is two palettes that build a chip *differently*, and
a gate that measures each against its own page.

### The old rule's arithmetic was correct and its premise was not

3:1 on both pages plus white ink at 4.5:1 pins a fill's relative luminance into
`L ∈ [0.1351, 0.1833]` — a range of **1.26:1**. So every chip, whatever it meant,
was forced to be a mid-dark saturated block. The premise justifying that was
"detection can fail, so a light fill may land on a dark terminal". It cannot:
`applyTuiTheme` resolves an unknown OSC answer to DARK and never to LIGHT, so a
light-palette fill is only ever painted on a page we measured and found light.
The cost was real and the protection was not.

Two rounds were spent inside that band before the constraint itself was
questioned — a cheap lesson to re-learn, so it is written down here rather than
in the file.

### What the two palettes now do

| | fill | ink | why |
|---|---|---|---|
| **dark** | SATURATED (`pillKeyBg` `#2f8250`) | light (`#ffffff`) | against near-black a colour must bring its own light |
| **light** | pale TINT of the hue (`#BCE5CD`) | DEEP ink of the SAME hue (`#166534`) | against white a saturated fill is a glaring block |

The owner's two verdicts, in order, are the whole derivation: *"this one is ugly
for light theme"*, then — after the first fix dropped each hue to its deep
sibling but kept the dark palette's saturated SHAPE — *"sub has a super green for
light theme background, that should be not as bright"*. Dropping the hue was not
enough, because the defect was never the hue. madbench's `internal/tui/theme.go`
states the same rule one level up: neon reads as brightness against black and as
glare against white.

**A tint is not a weaker chip; it moves the contrast from the fill to the ink.**
`SUB` on a light page prints `#166534` at 5.17:1 — text-grade — on a field that
is only 1.38:1 off white. The old construction had it backwards: it spent all the
contrast on the block and then had to print white on it.

### Roles, because one bar for everything is what produced the glare

- **SIGNAL** (`pillKeyBg`, `pillOauthBg`, `tabActiveBg`, `red`) — 3:1 against its
  own palette's reference page.
- **QUIET** (`pillCostBg`, both keycap segments) — a near-background fill, and
  the bar is a FLOOR *and a CEILING*: perceptible (≥ 1.10:1 off the page and off
  the `bgAlt` panel) and never louder than 3:1. The ceiling is the gate nobody
  had — a purple keycap at 5.04:1 on cream passed every earlier test, because
  "too loud" had not been written down as a failure.
- **Ink** is text-grade (4.5:1) on every chip, under both constructions. That is
  the one bar that did not move.

The keycap segments are also in `SURFACE_TOKENS`: a near-background fill IS a
surface, so it must be re-tinted onto a cream terminal exactly as `bgAlt` is.
`pillCostBg` LEFT that list when its label became `$$$` — see below; a fill whose
whole content is its hue cannot be re-expressed in the page's hue.

### Two fills still cannot be told apart by contrast ratio

The picker's billing column fills every row — `SUB`/`FREE`/`local` on `pillKeyBg`,
`$$$` on `pillCostBg` — so the design depends on the two reading as different, and
under the tinted construction they sit close in luminance. The assertion is
therefore perceptual: ΔE76 ≥ 20 (light measures 44.9, dark 63.4), in
`theme-contrast.test.ts` alongside a CIELAB helper written out independently for
the same reason the luminance formula is.

A column of identical fills still fuses — unchanged, and why a scoped flat-rate
roster draws its repeated `SUB` as text (`priceVaries`). ALTERNATING fills do
not, provided the alternation is measured rather than assumed.

### Reddish means TWO things now, and the second one had to buy its way in (2026-09-13)

The owner's instruction was *"instead of $ it should be '$$$' with light reddish
colour"*. Until then red was reserved for FAILURE — the `HTTP 401` badge fill, the
discovery banner's border and its `bgError` wash — and the metered chip was a
near-neutral slate, which is why the column read as "a claim (green) and the
absence of one" rather than as the opposition it actually encodes: **green is free
at the point of use, reddish costs you per token**.

Two meanings on one hue is admissible only while the two cannot be confused, so
the split is by REGISTER and the register is measured:

| | fill | ink | off its page |
|---|---|---|---|
| failure | SATURATED `C.red` | white | ≥ 3:1 (signal bar) |
| cost | QUIET tint `pillCostBg` | deep/pale rose | ≤ 3:1 (quiet ceiling) |

`theme-contrast.test.ts` pins, per palette: ΔE76 ≥ 20 from BOTH failure fills
(`C.red` **and** `C.bgError` — the wash is the panel, and a chip that matches the
panel is the defect), the cost fill under half the chroma of `C.red`, and failure
separating harder from the page than cost does. **If a future pass brings them
together it is the COST tint that moves.**

Hexes, both CIELAB hue ~11–13° (a warm rose, not a pink): light `#EDABB4` on
`#881337` ink, dark `#6B3B42` on `#F0B2BC`. Measured with
`validation/cost-chip-finalists.ts`: ΔE76 to `C.red` 65.4 / 73.7, to `C.bgError`
22.4 / 20.8, to `pillKeyBg` 44.9 / 63.4.

**The obvious literal was measured first and rejected.** madbench's `diffDelBg`
(`#F8D2D5` light, `#2E1216` dark) sits opposite the `diffAddBg` family the green
came from and is the natural pair — and it measures ΔE76 **6.3** and **9.7** from
`C.bgError`. That is the same colour to a reader: the chips would have looked like
fragments of the error panel. Clearing 20 without leaving the red arc costs two
steps of LIGHTNESS, which is what makes these dusty rather than pale. (A sweep with
no hue constraint answers with magenta and violet, because walking away from red
entirely is the cheapest way to satisfy the distance — which is not what was asked
for. The hue is a constraint; the quietness is what gets optimised inside it.)

The two never share a frame — the banner is drawn only by the models view, `$$$`
only by the provider list — but they are one keystroke apart, which is close
enough to carry the first into the second. `validation/cost-vs-error-montage.sh`
concatenates the two captures into one image so the comparison can actually be
looked at.

### A keycap is a PILL of two segments

`[ esc ][ quit ]` — the key segment brighter, the label segment quieter, the two
abutting with no cell between the fills. A single filled block beside bare text
is not a chip, and the two earlier answers were the same mistake from opposite
ends: one neutral grey for both themes (1.50:1 on dark, invisible) and then one
vivid purple for both (5.38:1 on light, the loudest thing on the screen). Both
failed because one hex served two pages.

The pill costs one cell more per hint than the block did, which is not free:
`Hints` sets `overflow="hidden"`, so at 80 columns the six-hint footer silently
clipped to `esc provider`. `hintsWidth` exists so that budget is arithmetic with
a test rather than a screenshot, and two labels were shortened to pay for it.
