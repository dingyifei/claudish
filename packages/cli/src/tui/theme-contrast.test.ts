import { afterEach, describe, expect, it } from "bun:test";
import { resetThemeModeForTests, setThemeMode } from "../theme/theme-mode.js";
import { C, CONTRAST_REFERENCE, STAGE_BG, STAGE_FG, latencyBg, latencyFg } from "./theme.js";
import type { TuiPalette } from "./theme.js";
import { ramps, tokens } from "./viz/tokens.js";

function channels(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected #rrggbb, received ${hex}`);

  return [0, 2, 4].map((offset) => Number.parseInt(match[1]!.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

// Independent of production color helpers so the palette cannot agree with a broken formula.
function relativeLuminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(first: string, second: string): number {
  const [high, low] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

/**
 * CIELAB, for the one question WCAG cannot answer.
 *
 * A contrast ratio is a function of LUMINANCE alone, so two fills of the same
 * lightness and wildly different hue score 1.0:1 against each other — indistinguishable
 * by that measure and obviously different to a reader. The picker's status column
 * needs exactly that distinction (a green chip alternating with a grey one), and the
 * luminance band an owned fill may occupy is too narrow to carry it, so the assertion
 * has to be perceptual. Written out here rather than imported for the same reason the
 * luminance formula is: the palette must not be able to agree with a broken helper.
 */
function lab(hex: string): [number, number, number] {
  const [red, green, blue] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const x = (0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047;
  const y = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const z = (0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** How LOUD a colour is — zero for any grey, ~52 for the green this fill replaced. */
function chroma(hex: string): number {
  const [, a, b] = lab(hex);
  return Math.hypot(a, b);
}

/** CIE76 perceptual distance. ~2.3 is a just-noticeable difference. */
function deltaE76(first: string, second: string): number {
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

resetThemeModeForTests();
const INITIAL_DARK_PALETTE: TuiPalette = { ...C };

afterEach(() => {
  resetThemeModeForTests();
});

describe("light TUI palette contrast", () => {
  const pageTextAccents = [
    "fg",
    "fgMuted",
    "dim",
    "strong",
    "green",
    "brightGreen",
    "red",
    "yellow",
    "cyan",
    "blue",
    "magenta",
    "orange",
    "tabInactiveFg",
  ] as const satisfies ReadonlyArray<keyof TuiPalette>;

  for (const accent of pageTextAccents) {
    it(`keeps ${accent} at 4.5:1 or better on the page`, () => {
      setThemeMode("light");
      expect(C.bg).toBe("#ffffff");
      expect(contrastRatio(C[accent], C.bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  // The SATURATED fills — the ones that still carry `C.ink` (white) on this page.
  // The picker's status chips are NOT here any more: on a light page they are tints
  // with deep ink, and each states its own ink. They are measured as pairs in
  // `every chip is a fill AND its ink` below.
  const whiteInkFills = ["pillOauthBg"] as const satisfies ReadonlyArray<keyof TuiPalette>;

  for (const fill of whiteInkFills) {
    it(`keeps ink legible on ${fill}`, () => {
      setThemeMode("light");
      expect(contrastRatio(C.ink, C[fill])).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps the active tab's own ink legible on its fill", () => {
    setThemeMode("light");
    expect(contrastRatio(C.tabActiveFg, C.tabActiveBg)).toBeGreaterThanOrEqual(4.5);
  });

  for (const latency of [100, 700, 2000, 4000, 10000]) {
    it(`keeps latency ink legible at ${latency}ms`, () => {
      setThemeMode("light");
      expect(contrastRatio(latencyFg, latencyBg(latency))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps both selection text roles legible on a visible wash", () => {
    setThemeMode("light");
    expect(contrastRatio(C.strong, C.bgHighlight)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(C.fg, C.bgHighlight)).toBeGreaterThanOrEqual(4.5);
    expect(C.bgHighlight).not.toBe(C.bg);
  });

  for (const stage of Object.keys(STAGE_BG) as Array<keyof typeof STAGE_BG>) {
    it(`keeps the ${stage} stage block visible on the page`, () => {
      setThemeMode("light");
      expect(contrastRatio(STAGE_BG[stage], C.bg)).toBeGreaterThanOrEqual(1.7);
    });
  }

  it("keeps normal text legible on the error wash", () => {
    setThemeMode("light");
    expect(contrastRatio(C.fg, C.bgError)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps both footer chip segments legible", () => {
    setThemeMode("light");
    expect(contrastRatio(C.fg, C.chipKeyBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(C.fgMuted, C.chipLabelBg)).toBeGreaterThanOrEqual(4.5);
  });

  it("RAISES the keycap chip off the panel it is drawn on", () => {
    // Legible ink is only half of a keycap: the chip also has to be visibly
    // raised off the band beneath it or it reads as a tinted word rather than as
    // a key you press. The owner reported exactly that from a live light-theme
    // run, and the old `#d1d5db` measured 1.32:1 against `bgAlt` — under the
    // 1.7:1 this file already requires of every stage block.
    setThemeMode("light");
    expect(contrastRatio(C.chipKeyBg, C.bgAlt)).toBeGreaterThanOrEqual(1.7);
  });

  it("keeps the detail pane's dim tiers legible on the PANEL — there is no band", () => {
    // The detail rows sit on the dialog's own `bgAlt`, with no fill of their own: a
    // pane separated by an absolute fill fights whichever theme we guessed, and the
    // owner rejected exactly that ("all text in description has different background
    // colours... please remove"). Receding is the TEXT's job, so the two tiers that
    // do the receding still have to clear a text-grade ratio on the panel itself.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      expect({ mode, ratio: contrastRatio(C.fgMuted, C.bgAlt) >= 4.5 }).toEqual({
        mode,
        ratio: true,
      });
    }
  });

  it("re-snapshots semantic tokens and ramps", () => {
    setThemeMode("light");
    expect(tokens.success).toBe(C.green);
    expect(tokens.bgPanel).toBe(C.bgAlt);
    expect(ramps.load[0]).toBe(C.green);
  });
});

/**
 * THE CHIP GATES — one reference page per palette, and one bar per ROLE.
 *
 * WHAT THIS REPLACED, AND WHY IT HAD TO. Until this pass every fill we paint had to
 * clear 3:1 against BOTH `#FAFAD2` and `#1C1C1E`, on the grounds that detection can
 * fail. Add white ink at 4.5:1 and that pins a fill's relative luminance to
 * L ∈ [0.1351, 0.1833] — a band 1.26:1 wide — so EVERY chip, whatever it meant, was
 * forced to be a mid-dark saturated block. The consequences were not theoretical:
 * the `SUB` green could only be softened on the chroma axis, and the quiet `$` had to
 * be a `#6b7280` slab at 4.53:1 on a light page, as heavy as the chip it was supposed
 * to recede behind. The owner's verdict on that screen: *"this one is ugly for light
 * theme"*, then *"sub has a super green for light theme background"*.
 *
 * The premise was also false. `applyTuiTheme` resolves an UNKNOWN answer to DARK,
 * never to LIGHT, so a light fill is only ever painted on a page we measured and
 * found light. Each palette is now measured against its own reference — still the
 * hostile end of its class (cream, not white; near-black, not black), so a fill that
 * passes survives a terminal that is not our hardcoded `C.bg`.
 *
 * AND THE BAR DEPENDS ON WHAT THE CHIP IS FOR, because 3:1 for everything is what
 * produced the glare. A SIGNAL marks the notable member of a column and separates
 * hard. A QUIET chip — the metered `$`, both keycap segments — is a near-background
 * fill whose job is to be perceptible and no more; holding it to 3:1 would demand the
 * very block the owner rejected. So a quiet fill gets a FLOOR and a CEILING, and what
 * has to be text-grade is the INK ON the chip, in every case.
 */
describe("chip gates: fill, ink, role and construction", () => {
  /** The page a palette is measured against. See this describe's header. */
  const REFERENCE_FOR_MODE = {
    light: CONTRAST_REFERENCE.light,
    dark: CONTRAST_REFERENCE.dark,
  } as const;

  /**
   * EVERY CHIP THIS PROGRAM PAINTS, AS A FILL-AND-INK PAIR.
   *
   * A fill on its own is not a chip and cannot be judged: the light palette's `SUB`
   * is a pale tint that would look broken under white ink and reads perfectly under
   * its own deep green. Listing pairs is what lets one gate cover both constructions.
   */
  const CHIPS = [
    { what: "status SUB/FREE/local", bg: "pillKeyBg", fg: "pillKeyFg", role: "signal" },
    // `$$$` is a SIGNAL in meaning and a QUIET fill in register, and it is listed as
    // quiet on purpose: the ceiling is the half of its contract that matters, because
    // the hue it carries is the one failure already owns.
    { what: "status $$$", bg: "pillCostBg", fg: "pillCostFg", role: "quiet" },
    { what: "keycap KEY segment", bg: "keycapKeyBg", fg: "keycapKeyFg", role: "quiet" },
    { what: "keycap LABEL segment", bg: "keycapLabelBg", fg: "keycapLabelFg", role: "quiet" },
  ] as const satisfies ReadonlyArray<{
    what: string;
    bg: keyof TuiPalette;
    fg: keyof TuiPalette;
    role: "signal" | "quiet";
  }>;

  /**
   * A quiet fill must be PERCEPTIBLE (you can see the chip's edge) and no louder.
   *
   * 1.10 is a floor on the edge, not on readability — readability is the ink gate,
   * and under the tinted construction the ink clears 5:1 while the field itself is
   * barely off the page. That is the point of a tint and it is why demanding 3:1 here
   * would reject a correct design.
   */
  const QUIET_EDGE_FLOOR = 1.1;
  /**
   * And the CEILING is the gate nobody had. `#9333ea` measured 5.04:1 on the cream
   * reference and 3.16:1 on the near-black one and passed every test in this file,
   * because "loud" was not a failure anyone had written down. It is now.
   */
  const QUIET_CEILING = 3;

  it("every chip is a FILL AND ITS INK, and the ink is text-grade on it", () => {
    // 4.5:1, in BOTH palettes and under BOTH constructions. This is the one bar that
    // does not move: whatever the fill does, the label on it has to be readable.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      for (const chip of CHIPS) {
        expect({
          mode,
          what: chip.what,
          ok: contrastRatio(C[chip.fg], C[chip.bg]) >= 4.5,
        }).toEqual({ mode, what: chip.what, ok: true });
      }
    }
  });

  it("every QUIET fill is perceptible off its own page, and never a beacon", () => {
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      const page = REFERENCE_FOR_MODE[mode];
      for (const chip of CHIPS.filter((c) => c.role === "quiet")) {
        const off = contrastRatio(C[chip.bg], page);
        expect({
          mode,
          what: chip.what,
          visible: off >= QUIET_EDGE_FLOOR,
          quiet: off <= QUIET_CEILING,
          // And off the PANEL it is actually drawn on, which is a shade nearer than
          // the page — the surface a chip can vanish into first.
          offPanel: contrastRatio(C[chip.bg], C.bgAlt) >= QUIET_EDGE_FLOOR,
        }).toEqual({ mode, what: chip.what, visible: true, quiet: true, offPanel: true });
      }
    }
  });

  it("THE SIGNAL CHIP IS BUILT DIFFERENTLY PER PALETTE — saturated on dark, a TINT on light", () => {
    // The construction, asserted rather than described. This is the thing that keeps
    // regressing: the previous pass correctly dropped each hue to its deep sibling
    // and then kept the DARK palette's saturated-fill-with-white-ink shape on a white
    // page, which is what the owner rejected as "super green". A hex check would not
    // have caught it — the hex was right for a badge on black.
    setThemeMode("dark");
    expect({
      mode: "dark",
      separatesHard: contrastRatio(C.pillKeyBg, CONTRAST_REFERENCE.dark) >= 3,
      lightInk: relativeLuminance(C.pillKeyFg) > relativeLuminance(C.pillKeyBg),
    }).toEqual({ mode: "dark", separatesHard: true, lightInk: true });

    setThemeMode("light");
    expect({
      mode: "light",
      // A TINT: pale enough that it is NOT a block on the page. The bound is the
      // assertion — anything above it is the saturated construction in disguise.
      isTint: contrastRatio(C.pillKeyBg, CONTRAST_REFERENCE.light) <= 2,
      darkInk: relativeLuminance(C.pillKeyFg) < relativeLuminance(C.pillKeyBg),
      // …and the ink is the fill's OWN hue, not a neutral: a pale green field with
      // grey text is two colours, not one chip.
      inkCarriesTheHue: chroma(C.pillKeyFg) > 20,
    }).toEqual({ mode: "light", isTint: true, darkInk: true, inkCarriesTheHue: true });
  });

  it("keeps the SATURATED signal fills at 3:1 on their own page", () => {
    // These did not change construction and are still blocks with white ink: the
    // config TUI's oauth pill, the active tab, and the failure hue.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      const page = REFERENCE_FOR_MODE[mode];
      for (const fill of ["pillOauthBg", "tabActiveBg", "red"] as const) {
        expect({ mode, fill, ok: contrastRatio(C[fill], page) >= 3 }).toEqual({
          mode,
          fill,
          ok: true,
        });
      }
    }
  });

  it("THE KEYCAP IS ONE PILL OF TWO SEGMENTS — the seam reads, and the key leads", () => {
    // The owner asked for a chip, not a coloured word: *"the key itself brighter
    // colour and label has backdrop but not as bright"*. Two things can go wrong and
    // neither shows up in a character frame — the segments can collapse into one flat
    // block, or they can invert so the label out-shouts the key.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      const page = REFERENCE_FOR_MODE[mode];
      expect({
        mode,
        seamReads: contrastRatio(C.keycapKeyBg, C.keycapLabelBg) >= 1.25,
        keyLeads: contrastRatio(C.keycapKeyBg, page) > contrastRatio(C.keycapLabelBg, page),
        // The key half is the pressable one, so it gets a higher floor than the
        // label: the grey claudeup measured as invisible was 1.50:1 on this page.
        keyIsPressable: contrastRatio(C.keycapKeyBg, page) >= 1.5,
      }).toEqual({ mode, seamReads: true, keyLeads: true, keyIsPressable: true });
    }
  });

  it("A KEYCAP IS NEVER THE NEUTRAL GREY AGAIN, in either palette", () => {
    // The regression this exists for shipped twice, once per palette: a grey keycap
    // reads as a faintly tinted word rather than as a key you press, and the owner
    // reported it from a live light-theme run. `chipKeyBg` survives as the config
    // TUI's two-tone footer segment, whose ink is theme-following `C.fg` and which is
    // measured against `bgAlt` above — a different object with a different contract.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      expect({ mode, same: C.keycapKeyBg === C.chipKeyBg }).toEqual({ mode, same: false });
    }
  });

  it("HOLDS EVERY PAIR OF STATUS-COLUMN FILLS APART — the banding gate", () => {
    // The picker's billing column carries a fill on EVERY row: `SUB`/`FREE`/`local` on
    // `pillKeyBg`, `$$$` on `pillCostBg`. That is the shape that fused into one solid
    // vertical band when the prefix column was chipped — and what failed there was
    // that all 17 fills were the SAME colour. Here they alternate, so the whole
    // design rests on the fills being visibly different.
    //
    // THE COLUMN HAS FOUR LABELS AND TWO FILLS, SO EVERY PAIR IS MEASURED HERE IN
    // TWO HALVES. `$$$` / `SUB` / `FREE` / `local` is the closed vocabulary
    // (`CHIP_COLUMN_LABELS`); WHICH fill each word takes is pinned in
    // `row-semantics.test.ts`, where the functions that decide it live —
    // `FREE`, `SUB` and `local` share `pillKeyBg` because all three make the same
    // claim, and only `$$$` takes `pillCostBg`. That leaves exactly one pair of
    // DISTINCT fills, and this is it. A third fill appearing in that column without
    // arriving here is the regression the two tests jointly catch: the mapping test
    // would fail on the label, this one on the distance.
    const COLUMN_FILLS = ["pillKeyBg", "pillCostBg"] as const;
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      for (let i = 0; i < COLUMN_FILLS.length; i++) {
        for (let j = i + 1; j < COLUMN_FILLS.length; j++) {
          const pair = `${COLUMN_FILLS[i]} vs ${COLUMN_FILLS[j]}`;
          const [a, b] = [C[COLUMN_FILLS[i]!], C[COLUMN_FILLS[j]!]];
          expect({ mode, pair, distinct: a !== b, apart: deltaE76(a, b) >= 20 }).toEqual({
            mode,
            pair,
            distinct: true,
            apart: true,
          });
        }
      }
    }
  });

  it("KEEPS THE COST CHIP OUT OF THE FAILURE REGISTER — the cost-vs-error gate", () => {
    // THE CONSTRAINT THIS FEATURE WAS ALLOWED UNDER. Red was reserved for FAILURE
    // here — the `HTTP 401` badge fill, the discovery banner's border and its wash —
    // and `$$$` introduces a second reddish meaning. That is admissible only while the
    // two cannot be mistaken for each other, because if they can, the error panel
    // stops reading as an error, which is a worse defect than the one being fixed.
    //
    // IT IS RESOLVED BY REGISTER AND MEASURED IN FOUR WAYS. Distance (ΔE76, the same
    // instrument and the same floor as the banding gate above, against BOTH failure
    // fills); loudness (the cost fill carries under half the chroma of the alarm hue);
    // and separation (failure separates HARDER from the page than cost does, which is
    // what "saturated versus tint" means in a number).
    //
    // IF A FUTURE PASS BRINGS THESE TOGETHER, THE COST TINT IS THE ONE THAT MOVES.
    // The error colour is load-bearing for a state the user cannot afford to misread.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      const page = REFERENCE_FOR_MODE[mode];
      for (const [what, failure] of [
        ["badge fill / banner border", C.red],
        ["banner wash", C.bgError],
      ] as const) {
        expect({
          mode,
          what,
          apart: deltaE76(C.pillCostBg, failure) >= 20,
        }).toEqual({ mode, what, apart: true });
      }
      expect({
        mode,
        // A TINT, not the alarm hue at a different lightness.
        quieterHue: chroma(C.pillCostBg) < chroma(C.red) / 2,
        // The failure fill is the one that separates hard. `C.red` clears 3:1 on its
        // own page (pinned above); the cost fill is under the quiet CEILING. Stating
        // the comparison directly is what survives a future re-tune of either.
        failureSeparatesHarder:
          contrastRatio(C.red, page) > contrastRatio(C.pillCostBg, page) &&
          contrastRatio(C.pillCostBg, page) <= QUIET_CEILING,
      }).toEqual({ mode, quieterHue: true, failureSeparatesHarder: true });
    }
  });

  it("KEEPS THE POSITIVE FILL SOFTER THAN THE TEXT-GRADE GREEN IT CAME FROM", () => {
    // `pillKeyBg` was `#15803d` — claudeup's `success`, and also this palette's light
    // `green`, which is a TEXT accent held to 4.5:1 on white. The owner's verdict on
    // it as an AREA was "make sub badge not as bright, make it softer", twice, once
    // per construction. Softness is chroma, and the pin is the COMPARISON rather than
    // a hex: a future green may be softer still, but it may not climb back to a
    // foreground's saturation.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      expect({ mode, softer: chroma(C.pillKeyBg) < chroma("#15803d") }).toEqual({
        mode,
        softer: true,
      });
      // A fill is never the neon/page-text green of its own palette either.
      expect(C.pillKeyBg).not.toBe(C.green);
    }
  });

  it("holds the POSITIVE family apart from the FAILURE hue", () => {
    // `SUB` shipped in `tokens.warn`, the hue this app spends on failure, under a
    // label that means the opposite of a failure. Three reviewers read it as correct,
    // so the separation is asserted rather than described.
    for (const mode of ["light", "dark"] as const) {
      setThemeMode(mode);
      expect(C.pillKeyBg).not.toBe(C.red);
      expect(C.pillKeyBg).not.toBe(C.orange);
    }
  });
});

describe("dark TUI palette identity", () => {
  it("pins the shipped dark values", () => {
    resetThemeModeForTests();
    expect(C.bg).toBe("#000000");
    expect(C.green).toBe("#39ff14");
    expect(C.fg).toBe("#ffffff");
    expect(STAGE_BG.streaming).toBe("#ffcc00");
  });

  it("restores every palette field after a light-to-dark flip", () => {
    setThemeMode("light");
    expect(C).not.toEqual(INITIAL_DARK_PALETTE);

    setThemeMode("dark");
    expect(C).toEqual(INITIAL_DARK_PALETTE);
  });

  it("refreshes stage foregrounds after a light-to-dark flip", () => {
    setThemeMode("light");
    expect(STAGE_FG.network).toBe(C.cyan);
    expect(STAGE_FG.server).toBe(C.blue);
    expect(STAGE_FG.streaming).toBe(C.yellow);

    setThemeMode("dark");
    expect(STAGE_FG.network).toBe(C.cyan);
    expect(STAGE_FG.server).toBe(C.blue);
    expect(STAGE_FG.streaming).toBe(C.yellow);
  });
});
