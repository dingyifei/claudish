import { loadLocalConfig } from "../../profile-config.js";
import type { ClaudishProfileConfig, ModelMapping } from "../../profile-config.js";
import { DETAIL_H } from "../constants.js";
/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";

interface ProfileDetailProps {
  config: ClaudishProfileConfig;
  profileIndex: number;
}

export function ProfileDetail({ config, profileIndex }: ProfileDetailProps) {
  const globalCfg = config;
  const localCfg = loadLocalConfig();
  const localProfileNames = localCfg ? new Set(Object.keys(localCfg.profiles)) : new Set<string>();

  // Resolve selected profile entry
  const allEntries: Array<{
    name: string;
    scope: "local" | "global";
    models: ModelMapping;
  }> = [];
  if (localCfg) {
    for (const [name, prof] of Object.entries(localCfg.profiles)) {
      allEntries.push({ name, scope: "local", models: prof.models });
    }
  }
  for (const [name, prof] of Object.entries(globalCfg.profiles)) {
    allEntries.push({ name, scope: "global", models: prof.models });
  }

  const entry = allEntries[profileIndex];
  const isActive = entry ? entry.name === globalCfg.defaultProfile : false;
  const shadowed = entry ? entry.scope === "global" && localProfileNames.has(entry.name) : false;

  return (
    <box
      height={DETAIL_H}
      border
      borderStyle="single"
      borderColor={C.dim}
      title={entry ? ` ${entry.name} ` : " (no selection) "}
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      {entry ? (
        <>
          {(["opus", "sonnet", "haiku", "subagent"] as const).map((role) => {
            const val = entry.models[role];
            const isAuto = !val;
            const label = role.padEnd(8);
            return (
              <text key={role}>
                <span fg={C.blue} attributes={A.bold}>
                  {`${label}: `}
                </span>
                {/* An unmapped role sends whatever model the session would (the
                    --model default, else Claude Code's own), and that name is
                    routed as every name is: native, a user rule, or the catalog.
                    There is no routing table to consult. */}
                {isAuto ? (
                  <>
                    <span fg={C.yellow}>(auto-route</span>
                    <span fg={C.dim}> — calculated per model · Routing → p shows the chain</span>
                    <span fg={C.yellow}>)</span>
                  </>
                ) : (
                  <span fg={C.cyan}>{val}</span>
                )}
              </text>
            );
          })}
          <text>
            <span fg={C.blue} attributes={A.bold}>
              {"Scope:    "}
            </span>
            <span fg={entry.scope === "local" ? C.cyan : C.fgMuted}>
              {entry.scope === "local"
                ? "local (.claudish.json)"
                : "global (~/.claudish/config.json)"}
            </span>
            {isActive && (
              <span fg={C.orange} attributes={A.bold}>
                {"  ● active"}
              </span>
            )}
            {shadowed && <span fg={C.dim}>{"  (shadowed)"}</span>}
          </text>
        </>
      ) : (
        <text>
          <span fg={C.fgMuted}>{"No profiles configured."}</span>
        </text>
      )}
    </box>
  );
}
