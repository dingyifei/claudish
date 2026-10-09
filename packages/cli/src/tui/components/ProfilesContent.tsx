import { loadLocalConfig } from "../../profile-config.js";
import type { ClaudishProfileConfig, ModelMapping } from "../../profile-config.js";
import { getProviderPrefixes } from "../constants.js";
/** @jsxImportSource @opentui/react */
import { A, C } from "../theme.js";
import type { Mode, Tab } from "../types.js";

interface ProfilesContentProps {
  config: ClaudishProfileConfig;
  activeTab: Tab;
  mode: Mode;
  profileScope: "global" | "project";
  profileIndex: number;
  editProfileValue: string;
  suggestions: string[];
  suggestionIndex: number;
  providerPickerIndex: number;
  width: number;
  contentH: number;
  // Wizard select integration — App owns these cursors so the global
  // keyboard handler's Enter can commit the highlighted row. The native
  // <select> renders its own highlight; onChange keeps these in sync.
  onScopeChange: (index: number) => void;
  onPrefixChange: (index: number) => void;
}

// ── Wizard step metadata ───────────────────────────────────────────────────
// The "New Profile" wizard is a linear sequence. Each linear step gets a
// "Step N of M" header so the bordered modal reads as one coherent flow.
// The provider-prefix picker is a side-trip (Tab from an empty model field),
// so it gets a plain title, not a step number.
const WIZARD_STEPS: Mode[] = [
  "pick_profile_scope",
  "new_profile",
  "edit_profile_opus",
  "edit_profile_sonnet",
  "edit_profile_haiku",
  "edit_profile_subagent",
];
const TOTAL_STEPS = WIZARD_STEPS.length;

function stepLabel(mode: Mode): { title: string; header: string } {
  const idx = WIZARD_STEPS.indexOf(mode);
  const stepNo = idx >= 0 ? idx + 1 : 0;
  const prefix = stepNo > 0 ? `Step ${stepNo} of ${TOTAL_STEPS} — ` : "";
  switch (mode) {
    case "pick_profile_scope":
      return { title: "New Profile", header: `${prefix}Choose scope` };
    case "new_profile":
      return { title: "New Profile", header: `${prefix}Profile name` };
    case "edit_profile_opus":
      return { title: "New Profile", header: `${prefix}opus model` };
    case "edit_profile_sonnet":
      return { title: "New Profile", header: `${prefix}sonnet model` };
    case "edit_profile_haiku":
      return { title: "New Profile", header: `${prefix}haiku model` };
    case "edit_profile_subagent":
      return { title: "New Profile", header: `${prefix}subagent model (optional)` };
    case "pick_provider_prefix":
      return { title: "Choose provider", header: "Pick a provider prefix" };
    default:
      return { title: "New Profile", header: "" };
  }
}

export function ProfilesContent({
  config,
  activeTab,
  mode,
  profileScope,
  profileIndex,
  editProfileValue,
  suggestions,
  suggestionIndex,
  providerPickerIndex,
  contentH,
  onScopeChange,
  onPrefixChange,
}: ProfilesContentProps) {
  const isProfileEditMode =
    mode === "new_profile" ||
    mode === "pick_profile_scope" ||
    mode === "pick_provider_prefix" ||
    mode === "edit_profile_opus" ||
    mode === "edit_profile_sonnet" ||
    mode === "edit_profile_haiku" ||
    mode === "edit_profile_subagent";

  const isTextStep =
    mode === "new_profile" ||
    mode === "edit_profile_opus" ||
    mode === "edit_profile_sonnet" ||
    mode === "edit_profile_haiku" ||
    mode === "edit_profile_subagent";

  const globalCfg = config;
  const localCfg = loadLocalConfig();
  const localProfileNames = localCfg ? new Set(Object.keys(localCfg.profiles)) : new Set<string>();

  // Build unified list: local profiles first, then global
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

  const activeProfileName = globalCfg.defaultProfile;
  const listH = contentH - 2;

  const { title: modalTitle, header: modalHeader } = stepLabel(mode);

  // Scope options — path baked into the name string, padded for alignment, so
  // each choice renders as exactly ONE line (showDescription={false}). This is
  // the critical fix: the native <select> with descriptions stacks
  // name-over-description (2 lines each), making 2 choices look like 4.
  const scopeOptions = [
    { name: "global    ~/.claudish/config.json", description: "", value: "global" },
    { name: "project   ./.claudish.json", description: "", value: "project" },
  ];

  // Provider prefix options — same one-line treatment. Prefix left-padded to a
  // fixed width so the display name aligns into a clean second column.
  // Pad to the widest prefix + a 2-space gutter so the display-name column
  // aligns cleanly even for long prefixes like "gemini-codeassist@".
  // One call, two uses. `getProviderPrefixes()` builds a fresh array per call
  // (deliberately — see its doc), so asking twice per render allocates twice and,
  // worse, would let the width be computed from a different prefix list than the rows
  // if a provider were ever registered between the two calls.
  const prefixes = getProviderPrefixes();
  const prefixColW = prefixes.reduce((max, p) => Math.max(max, p.prefix.length), 0) + 2;
  const prefixOptions = prefixes.map((p) => ({
    name: `${p.prefix.padEnd(prefixColW)}${p.displayName}`,
    description: "",
    value: p.prefix,
  }));

  return (
    <box
      height={contentH}
      border
      borderStyle="single"
      borderColor={activeTab === "profiles" && !isProfileEditMode ? C.blue : C.dim}
      backgroundColor={C.bg}
      flexDirection="column"
      paddingX={1}
    >
      {/* Active profile indicator */}
      <text>
        <span fg={C.dim}>{"  "}</span>
        <span fg={C.fgMuted}>Active profile: </span>
        <span fg={C.orange} attributes={A.bold}>
          {activeProfileName}
        </span>
      </text>
      {/* Column header */}
      <text>
        <span fg={C.dim}>{"   "}</span>
        <span fg={C.blue} attributes={A.bold}>
          {"PROFILE         "}
        </span>
        <span fg={C.blue} attributes={A.bold}>
          {"SCOPE    "}
        </span>
        <span fg={C.blue} attributes={A.bold}>
          {"MODELS"}
        </span>
      </text>
      {/* Profile rows */}
      {allEntries.slice(0, Math.max(0, listH - 3)).map((entry, idx) => {
        const isActive = entry.name === activeProfileName;
        const selected = idx === profileIndex;
        const namePad = entry.name.padEnd(16).substring(0, 16);
        const scopePad = entry.scope.padEnd(8).substring(0, 8);
        const shadowed = entry.scope === "global" && localProfileNames.has(entry.name);

        const modelSummary =
          [
            entry.models.opus ? `opus→${entry.models.opus.substring(0, 14)}` : null,
            entry.models.sonnet ? `sonnet→${entry.models.sonnet.substring(0, 14)}` : null,
          ]
            .filter(Boolean)
            .join("  ") || "(auto-route)";

        return (
          <box
            key={`${entry.scope}-${entry.name}`}
            height={1}
            flexDirection="row"
            backgroundColor={selected ? C.bgHighlight : C.bg}
          >
            <text>
              <span fg={isActive ? C.orange : C.dim}>{isActive ? "●" : " "}</span>
              <span fg={C.dim}> </span>
              <span
                fg={selected ? C.strong : isActive ? C.orange : C.fgMuted}
                attributes={A.boldIf(selected || isActive)}
              >
                {namePad}
              </span>
              <span fg={C.dim}>{"  "}</span>
              <span fg={entry.scope === "local" ? C.cyan : C.fgMuted}>{scopePad}</span>
              <span fg={C.dim}>{"  "}</span>
              <span fg={selected ? C.strong : shadowed ? C.dim : C.fgMuted}>
                {shadowed ? "(shadowed by local)  " : modelSummary}
              </span>
            </text>
          </box>
        );
      })}

      {/* Local profiles note */}
      {!localCfg && (
        <text>
          <span fg={C.dim}>{"  No project-level profiles (.claudish.json)"}</span>
        </text>
      )}

      {/* ── Bordered wizard modal ─────────────────────────────────────────── */}
      {/* A single bordered panel owns each step. Title + "Step N of M" header
          stay consistent across every step so the flow reads as one coherent
          wizard. The modal appears BELOW the existing profile list. */}
      {isProfileEditMode && (
        <box
          border
          borderStyle="rounded"
          borderColor={C.blue}
          title={modalTitle}
          titleAlignment="left"
          backgroundColor={C.bg}
          flexDirection="column"
          paddingX={1}
          marginTop={1}
        >
          {/* Step header */}
          <text>
            <span fg={C.cyan} attributes={A.bold}>
              {modalHeader}
            </span>
          </text>

          {/* Scope step — one-line <select> */}
          {mode === "pick_profile_scope" && (
            <box flexDirection="column" paddingTop={1}>
              <select
                options={scopeOptions}
                focused={true}
                showDescription={false}
                wrapSelection={true}
                onChange={onScopeChange}
                backgroundColor={C.bg}
                textColor={C.fgMuted}
                selectedBackgroundColor={C.bgHighlight}
                selectedTextColor={C.strong}
                height={scopeOptions.length}
              />
              <text>
                <span fg={C.dim}> </span>
              </text>
              <text>
                <span fg={C.fgMuted}>↑↓ move · </span>
                <span fg={C.green} attributes={A.bold}>
                  ⏎{" "}
                </span>
                <span fg={C.fgMuted}>next · </span>
                <span fg={C.red} attributes={A.bold}>
                  esc{" "}
                </span>
                <span fg={C.fgMuted}>cancel</span>
              </text>
            </box>
          )}

          {/* Provider prefix step — one-line <select> */}
          {mode === "pick_provider_prefix" && (
            <box flexDirection="column" paddingTop={1}>
              <select
                options={prefixOptions}
                focused={true}
                showDescription={false}
                wrapSelection={true}
                selectedIndex={providerPickerIndex}
                onChange={onPrefixChange}
                backgroundColor={C.bg}
                textColor={C.fgMuted}
                selectedBackgroundColor={C.bgHighlight}
                selectedTextColor={C.cyan}
                height={Math.min(8, prefixOptions.length)}
                showScrollIndicator={true}
              />
              <text>
                <span fg={C.dim}> </span>
              </text>
              <text>
                <span fg={C.fgMuted}>↑↓ move · </span>
                <span fg={C.green} attributes={A.bold}>
                  ⏎{" "}
                </span>
                <span fg={C.fgMuted}>select · </span>
                <span fg={C.red} attributes={A.bold}>
                  esc{" "}
                </span>
                <span fg={C.fgMuted}>back</span>
              </text>
            </box>
          )}

          {/* Text steps — profile name + model role fields */}
          {isTextStep && (
            <box flexDirection="column" paddingTop={1}>
              {/* Scope reminder on the name step so the user knows where the
                  profile will be written. */}
              {mode === "new_profile" && (
                <text>
                  <span fg={C.fgMuted}>scope: </span>
                  <span fg={profileScope === "project" ? C.cyan : C.green} attributes={A.bold}>
                    {profileScope}
                  </span>
                </text>
              )}

              <text>
                <span fg={C.green} attributes={A.bold}>
                  {"> "}
                </span>
                <span fg={editProfileValue === "auto" ? C.yellow : C.strong}>
                  {editProfileValue}
                </span>
                <span fg={C.cyan}>{"█"}</span>
              </text>

              {/* Suggestion list (model role steps only) */}
              {suggestions.length > 0 && (
                <box flexDirection="column">
                  {suggestions.map((s, idx) => {
                    const selected = idx === suggestionIndex;
                    const lower = editProfileValue.toLowerCase();
                    const matchIdx = lower ? s.toLowerCase().indexOf(lower) : -1;
                    return (
                      <box key={s} height={1} backgroundColor={selected ? C.bgHighlight : C.bg}>
                        <text>
                          <span fg={selected ? C.dim : C.dim}>{"  "}</span>
                          {matchIdx >= 0 && lower ? (
                            <>
                              <span fg={selected ? C.fgMuted : C.dim}>
                                {s.substring(0, matchIdx)}
                              </span>
                              <span fg={selected ? C.strong : C.cyan} attributes={A.bold}>
                                {s.substring(matchIdx, matchIdx + lower.length)}
                              </span>
                              <span fg={selected ? C.fgMuted : C.dim}>
                                {s.substring(matchIdx + lower.length)}
                              </span>
                            </>
                          ) : (
                            <span fg={selected ? C.strong : C.fgMuted}>{s}</span>
                          )}
                        </text>
                      </box>
                    );
                  })}
                </box>
              )}

              {/* Inline hint line */}
              {mode === "new_profile" ? (
                <text>
                  <span fg={C.green} attributes={A.bold}>
                    ⏎{" "}
                  </span>
                  <span fg={C.fgMuted}>next · </span>
                  <span fg={C.red} attributes={A.bold}>
                    esc{" "}
                  </span>
                  <span fg={C.fgMuted}>cancel</span>
                </text>
              ) : editProfileValue === "auto" ? (
                <text>
                  <span fg={C.yellow} attributes={A.bold}>
                    auto-route{" "}
                  </span>
                  <span fg={C.fgMuted}>— calculated per model (Routing → p) · </span>
                  <span fg={C.green} attributes={A.bold}>
                    ⏎{" "}
                  </span>
                  <span fg={C.fgMuted}>next · </span>
                  <span fg={C.red} attributes={A.bold}>
                    esc{" "}
                  </span>
                  <span fg={C.fgMuted}>cancel</span>
                </text>
              ) : (
                <text>
                  <span fg={C.green} attributes={A.bold}>
                    ⏎{" "}
                  </span>
                  <span fg={C.fgMuted}>next · </span>
                  <span fg={C.blue} attributes={A.bold}>
                    ⇥{" "}
                  </span>
                  <span fg={C.fgMuted}>
                    {editProfileValue === "" ? "provider · " : "complete · "}
                  </span>
                  <span fg={C.blue} attributes={A.bold}>
                    ↑↓{" "}
                  </span>
                  <span fg={C.fgMuted}>pick · </span>
                  <span fg={C.yellow} attributes={A.bold}>
                    a{" "}
                  </span>
                  <span fg={C.fgMuted}>auto · </span>
                  <span fg={C.red} attributes={A.bold}>
                    esc{" "}
                  </span>
                  <span fg={C.fgMuted}>cancel</span>
                </text>
              )}
            </box>
          )}
        </box>
      )}
    </box>
  );
}
