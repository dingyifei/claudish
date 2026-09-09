/**
 * The overall result of a route probe, derived from its rows.
 *
 * Three outcomes, not two. A native Claude route cannot be probed from the TUI
 * (the native handler authenticates with the inbound Claude Code header, which
 * a synthetic probe cannot supply — native-handler.ts), so its row is
 * `unverified`. Collapsing that into "no success row → no route" painted
 * `claude-opus-5` as "✗ No provider could serve this model", which is false.
 * Pure, so the panel's decision is unit-testable without a renderer.
 */

import type { ProbeEntry, ProbeMode } from "./types.js";

export type ProbeOutcome = "running" | "routed" | "unverified" | "no-route";

export function deriveProbeOutcome(mode: ProbeMode, results: ProbeEntry[]): ProbeOutcome {
  if (mode === "running") return "running";
  if (results.some((e) => e.status === "success")) return "routed";
  if (results.some((e) => e.status === "unverified")) return "unverified";
  return "no-route";
}
