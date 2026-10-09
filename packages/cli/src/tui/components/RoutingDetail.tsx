import { DETAIL_H } from "../constants.js";
/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import type { ProbeMode } from "../types.js";
import type { MergedRule } from "../types.js";

interface RoutingDetailProps {
  probeMode: ProbeMode;
  mergedRules: MergedRule[];
}

export function RoutingDetail({ probeMode, mergedRules }: RoutingDetailProps) {
  // Probe is full-screen — no separate detail panel shown
  if (probeMode !== "idle") {
    return null;
  }

  // Two kinds of row, because a row can only be one of the user's own rules
  // now. The "built-in default" and "override of default" counts this panel
  // used to carry were both about the shipped table of built-in rules, which
  // was deleted when routing started gathering candidates from the cloud models
  // catalog — they would now read 0 and 0 forever.
  const globalCustom = mergedRules.filter((r) => r.kind === "global").length;
  const projectRules = mergedRules.filter((r) => r.kind === "project");
  // A "*" rule matches everything no other rule does, so with one nothing
  // reaches the catalog (the header above says the same).
  const hasCatchAll = mergedRules.some((r) => r.pattern === "*");

  // Format counts with a fixed-width number column so the labels line up
  // even when counts grow into double digits.
  const fmtCount = (n: number): string => String(n).padStart(2, " ");

  return (
    <box
      height={DETAIL_H}
      border
      borderStyle="single"
      borderColor={C.dim}
      title=" Legend "
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      {/* Two columns of marker/count pairs on each line. Markers stay in
          column 1 (single glyph) so the eye can scan vertically. Labels
          and counts line up via fixed-width pads. */}
      <box height={1} flexDirection="row">
        <box width={32}>
          <text>
            <span fg={C.green} attributes={A.bold}>
              {" •  "}
            </span>
            <span fg={C.fgMuted}>{"global rule          "}</span>
            <span fg={C.green} attributes={A.bold}>
              {fmtCount(globalCustom)}
            </span>
          </text>
        </box>
        <box>
          <text>
            <span fg={C.cyan} attributes={A.bold}>
              {"  ▴  "}
            </span>
            <span fg={C.fgMuted}>{"project rule         "}</span>
            <span fg={C.cyan} attributes={A.bold}>
              {fmtCount(projectRules.length)}
            </span>
          </text>
        </box>
      </box>
      <box height={1} flexDirection="row">
        <box>
          <text>
            <span fg={C.fgMuted}>
              {hasCatchAll
                ? ' The "*" rule takes every model no other rule here matches.'
                : " Anything with no rule here is routed from the cloud models catalog."}
            </span>
          </text>
        </box>
      </box>
    </box>
  );
}
