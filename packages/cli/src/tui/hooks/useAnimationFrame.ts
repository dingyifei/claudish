/**
 * useAnimationFrame — the repo's ONE tick source for indeterminate progress.
 *
 * Lifted verbatim from `probe/probe-tui-app.tsx:167-175`, which now re-exports it
 * so `probe/` needs no edit. It moved for one reason: it was the only exported
 * tick source in the codebase and it lived inside a 1,500-line component module,
 * so a second OpenTUI app could not have it without importing the probe's whole
 * component tree. `probe/ → tui/` is an edge that already exists
 * (`probe-tui-app.tsx:35` imports `../tui/theme.js`); `tui/ → probe/` does not
 * exist and must not be created. Hence the hook lives on the `tui/` side.
 *
 * 100 ms, GATED ON `active`: an inactive caller registers no interval at all, so
 * a screen with nothing in flight costs nothing per frame and a settled screen
 * stops re-rendering entirely. The counter wraps at 1e6 rather than growing
 * without bound — every reader takes it modulo a small bar width.
 *
 * NOT `useTimeline`, which does exist at the 0.1.107 pin and has zero uses here:
 * a timeline is a tween driver for eased property animation, and nothing that
 * reads this counter eases. A 100 ms integer is the house idiom.
 */

import { useEffect, useState } from "react";

/** Bumps a counter every 100ms while active — used for progress bar animation and elapsed timers. */
export function useAnimationFrame(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % 1_000_000), 100);
    return () => clearInterval(id);
  }, [active]);
  return frame;
}
