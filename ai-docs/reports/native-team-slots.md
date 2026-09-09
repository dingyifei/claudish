# Native Claude as a `team` slot — evidence, claudish fix, and magus-src instructions

**Date:** 2026-08-22 · **Verified against:** claudish worktree `worktree-fix-fault33` (v7.64.0),
multimodel plugin 3.6.0 (active in claudish project) / 3.8.0 (magus-src `main`).

## 1. The claim under test

`/team` splits the roster in two: external models go to the claudish `team` MCP tool, and
`internal` goes to a background `Agent`. The stated reason is that claudish cannot run a
native Claude model. **That reason is false.** Claudish runs native Claude fine; what it
could not run was the literal string `internal`.

## 2. Evidence (all measured, not inferred)

Every run below used the repo tree, not the installed binary
(`CLAUDISH_BIN=packages/cli/src/index.ts`), on a machine with **no provider credentials
configured** (`~/.claudish/config.json` → `apiKeys: []`, no `*_API_KEY` in env). No external
model and no API key was involved at any point — the native passthrough authenticates with
the user's own Claude subscription.

### 2.1 The route exists and is not "virtual"

| Location | What it does |
|---|---|
| `proxy-server.ts:524` | `if (monitorMode) return nativeHandler;` — global `--monitor` |
| `proxy-server.ts:786-790` | `const isNative = !target.includes("/") && !hasExplicitProvider; if (isNative) return nativeHandler;` — **per request, in ordinary mode** |
| `handlers/native-handler.ts` | the real handler class |
| `README.md:1015` | "**Pass-through proxy** - No translation, forwards as-is to Anthropic" |

`provider-definitions.ts:1256` declares `native-anthropic` with `noHandler("virtual", …)`
and an empty `baseUrl`. That is a **routing marker only** — the handler is returned by the
proxy before the routing engine runs. Reading the table entry alone leads to the wrong
conclusion that no execution path exists.

### 2.2 Authentication needs no API key

`claude-runner.ts:1304-1308` deletes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` so
Claude Code uses its own subscription login. `isProxyAuthMode` (`claude-runner.ts:219`)
returns false for native/monitor, so the `forceLoginMethod: "console"` overlay is not
injected either. This is why every run below worked with zero credentials configured.

### 2.3 The actual failure was the model NAME

Running the exact argv `team-orchestrator.ts` builds:

```
$ claudish --model internal -y --stdin --quiet   < vote-prompt
EXIT=1
There's an issue with the selected model (internal).
[claude-code:unrecognized_model] {"model":"internal","query_source":"sdk"}
"internal" is not a model this version of Claude Code recognizes

$ claudish --model opus -y --stdin --quiet       < vote-prompt
EXIT=0
```vote
VERDICT: APPROVE …
```

$ claudish --model claude-opus-4-1 -y --stdin --quiet < vote-prompt
EXIT=0   ⚠ claude-opus-4-1 is automatically remapped to Opus 5 (the latest Opus)
```

`internal` and `default` are **selectors**, not model ids. Claude Code rejects them. The
TIER they select is accepted. Note the third line: a pinned id only survives via a
client-side remap — consistent with `cli.ts:1237-1243`, which records that the probe's
hardcoded `claude-opus-4-1` had rotted to a 404. **Normalize to the tier, never to an id.**

### 2.4 The `team` guard was papering over exactly this bug

`team-orchestrator.ts:519` rejected `internal`/`default`/`opus`/`sonnet`/`haiku`/`claude-*`
in `setupSession`, throwing for the whole array (so one sentinel killed the entire run, not
just that slot). Commit `91ee9a8` explains why:

> Sentinel model names … **Previously these leaked through and failed with cryptic "model
> not found" errors.** Now setupSession() validates upfront with a clear error message.

The regression it fixed **is** §2.3. It was never guarding a hazard; it converted a cryptic
failure into a clear refusal instead of fixing the cause. Fixing the cause removes the need
for it. Note it also rejected `opus` — a name proven above to work.

### 2.5 `create_session` never had the guard

`mcp-server.ts:1340-1373` passes `args.model` straight through, and
`prehydrate.ts` `isRoutablyPinnable` already excludes native names from pinning, with the
comment: *"`team` screens these out upstream in `setupSession`, but `create_session` does
not."* So native names already reach claudish children through `/delegate` today. This also
means **no pin trap**: a native name stays bare, and the proxy's `isNative` test (no `/`,
no `@`) still matches.

## 3. The claudish fix (implemented in this worktree)

Chosen layer: **globally, at the `--model` parse boundary**, whose existing comment already
names it as the place where a value is normalized so that "every downstream consumer …
behaves exactly as it does for an ordinary `--model`".

| File | Change |
|---|---|
| `providers/claude-code-aliases.ts` | new `normalizeNativeModelSpec(spec)` — returns the tier for a selector, passes everything else through unchanged |
| `cli.ts:285` | `parseModelChain(modelArg).map(normalizeNativeModelSpec)` |
| `team-orchestrator.ts` | removed `SENTINEL_MODELS` / `isSentinelModel` / the `setupSession` throw; replaced with a comment recording why |
| `mcp-server.ts` | `team.models` description now says native names are runnable slots; new `buildChildClaudeFlags()`; `agent` + `claude_flags` on `team`, `agent` on `create_session` |
| `team-orchestrator.test.ts` | TEST-17..23 inverted: assert acceptance, not rejection |
| `providers/claude-code-aliases.test.ts` | added `normalizeNativeModelSpec` coverage |
| `agent-availability.ts` (new) | live agent-roster discovery + `assertAgentAvailable`, cached per cwd, fails open |
| `mcp-child-flags.test.ts` (new) | `buildChildClaudeFlags` coverage — 16 tests |
| `agent-availability.test.ts` (new) | roster parse, accept/reject, cwd isolation, fail-open — 10 tests |
| `cli-native-model-normalization.test.ts` (new) | pins the `--model` boundary WIRING via real `parseArgs` — 6 tests |

Because every path (`team`, `create_session`) ultimately spawns `claudish --model X`, the
child normalizes at its own boundary. The parent keeps the caller's string as the run's
identity in the manifest.

### 3.1 End-to-end verification of the fix

Driven through the real `setupSession` + `runModels`, `requirePattern: "```vote"`:

```
POSITIVE  team: 1 models, 1 done, 15s
          01 internal   done   1.0KB     state COMPLETED, exitCode 0
          response-01.md contains a real answer + ```vote VERDICT: APPROVE CONFIDENCE: 10```

NEGATIVE  team: 1 models, 1 failed, 6s
          01 internal   EMPT   191B      state EMPTY, reason "shape_mismatch"
          command: claudish --model internal -y --stdin --verbose --quiet --output-format stream-json
```

The negative control is the point of the whole exercise: **a native reviewer that never
produced a vote is now reported FAILED instead of silently succeeding.** Through the
`Agent` → `internal-result.md` path it cannot be, because claudish never sees that slot.

## 4. Instructions for the magus-src developer

**Repo:** `/Users/jack/mag/magus/magus-src` (branch `main`, plugin at version 3.8.0)
**Plugin root:** `/Users/jack/mag/magus/magus-src/plugins/multimodel`

**Prerequisite:** ship the claudish change first. These edits assume a claudish that
normalizes native selectors; against an older claudish, `internal` in the `models` array
throws and kills the whole run.

### 4.1 `/Users/jack/mag/magus/magus-src/plugins/multimodel/commands/team.md`

| Line | Current | Change to |
|---|---|---|
| 53 | `**CRITICAL:** "internal" is NOT a real model — never pass it to claudish. Filter it out first.` | **Delete.** Replace with: native names are ordinary slots and belong in `models`. |
| 55 | `**External models** (all models EXCEPT "internal"):` | `**All models** (native and external, one call):` |
| 57 | `models=[...all models with "internal" removed...]` | `models=[...all resolved models, internal included...]` and add `require_pattern="```vote"` |
| 61-68 | the `Agent(subagent_type=RESOLVED_AGENT, run_in_background=true, …)` block | **Delete entirely.** Step 2 becomes ONE call, so the "Issue BOTH calls in ONE message" instruction at line 50 also goes. |
| 74 | `- From the internal Agent: Read {SESSION_DIR}/internal-result.md` | **Delete.** All votes now come from the `team` response. |
| 90 | `| {model} | team MCP / Task | OK/FAILED | …` | Drop the `Task` method — every row is `team MCP`. |
| 40-42 | `**Resolve agent** (only if "internal" in model list) … Announce: "Agent: {RESOLVED_AGENT}"` | Keep, but drop the `only if "internal"` condition and pass the result as the tool's `agent` argument — see §4.5. |
| 44 | `**Session directory** (for internal model output)` | Reword: the session directory is now the `team` tool's session path, still required. |

### 4.2 `/Users/jack/mag/magus/magus-src/plugins/multimodel/commands/delegate.md`

| Line | Change |
|---|---|
| 71-77 | The whole "**Why step 2 skips `internal`**" rationale is now obsolete — it describes the §2.3 bug, which is fixed. Delete the skip, and delete the paragraph. `/delegate internal <task>` should now work through `create_session`. |
| 165 | `Special: internal means host Claude model — never sent to claudish.` → `internal / default select the host Claude tier; they run through claudish's native passthrough on the user's subscription.` |

### 4.3 `/Users/jack/mag/magus/magus-src/plugins/multimodel/skills/claudish-usage/SKILL.md`

Line 82: `4. "internal" is never sent to claudish — it means the host Claude model.`
→ `4. "internal" / "default" select the host Claude tier. They ARE sent to claudish and run
through the native passthrough (no API key, no translation); do not add a provider prefix.`

### 4.4 `/Users/jack/mag/magus/magus-src/plugins/multimodel/skills/task-external-models/SKILL.md`

Lines 32-38: the "**Internal model** (Claude) → `Agent(…, run_in_background: true)`" bullet
and its "Background is deliberate here" rationale are obsolete. Native and external models
now go through the same `team` call, which already runs them in parallel. Delete the bullet
and fold native names into the external-models bullet.

### 4.5 The agent persona — RESOLVED, claudish now carries it

`team` previously had no way to pass `--agent`, so moving `internal` into the `models` array
would have dropped `subagent_type=RESOLVED_AGENT`. That is fixed: the `team` tool now takes a
first-class **`agent`** parameter plus an open **`claude_flags`** passthrough. Both tools:

```
team            → mode, path, models, judges, input, timeout, require_pattern,
                  min_output_bytes, agent, claude_flags
create_session  → model, prompt, timeout_seconds, agent, claude_flags, work_dir
```

`agent` is first-class because selecting a subagent is the common case and a caller should not
need to know the flag spelling. `claude_flags` stays open because claudish forwards ANY
unrecognised flag to Claude Code (`cli.ts` catch-all, whose own comment uses `--agent detective`
as its example) — so `--effort`, `--permission-mode`, `--allowedTools` and anything added later
work with no claudish release. If both name an agent, the dedicated parameter wins and the
`--agent` pair inside `claude_flags` is dropped rather than emitted twice.

Verified live: the spawned command became

```
claudish --model internal -y --stdin --verbose --quiet --output-format stream-json --agent dev:reviewer
```

and an intentionally bogus name proves Claude Code honors rather than ignores it:

```
--agent 'zzz-not-a-real-agent' not found. Available agents: claude, code-analysis:detective,
… dev:architect, dev:debugger, dev:developer, … dev:researcher, dev:reviewer, … dev:test-architect …
```

Every agent `/team`'s context-detection table resolves to is in that list.

**So `team.md` lines 40-42 keep working, with one edit.** `**Resolve agent**` stays; the
condition `(only if "internal" in model list)` should go — the agent now applies to the whole
run. Pass it as a tool argument instead of an `Agent(subagent_type=…)` dispatch:

```
claudish team(mode="run", path=SESSION_DIR, models=[...all models, internal included...],
  input=VOTE_PROMPT, timeout=180, require_pattern="```vote", agent=RESOLVED_AGENT)
```

**One property to be aware of:** `agent` applies to EVERY child, native and external alike —
`team-orchestrator.ts` splices one shared flag array into each spawn, with no per-model slot.
For a blind voting panel that is arguably correct (every voter reviews by the same method, so
vote differences reflect the model rather than the prompt). If per-slot personas are ever
needed, that is a separate change: a per-entry flags field in the manifest.

### 4.6 No change needed

- `hooks/enforce-team-rules.sh` — does not police `internal`; verified by grep.
- `scripts/lib/preferences.ts:101` — the *behavior* (`internal` always survives catalog
  verification) stays correct, since `internal` is still not a catalog id. Only the comment
  ("not a claudish model") is now misleading; reword it.

## 4.7 A second silent-failure trap, found and closed

Claude Code validates `--agent` and fails loudly with the valid names — **except under
`--input-format stream-json`, where an unknown name is silently ignored and the DEFAULT agent
runs instead.** Measured 2026-08-22, one variable between the runs:

````
--output-format stream-json --input-format stream-json --agent zzz-bogus  → exit 0, no stderr
--output-format stream-json                            --agent zzz-bogus  → exit 1,
    "--agent 'zzz-bogus' not found. Available agents: …"
````

`team` spawns `--stdin` and is unaffected; the channel transport (`create_session`) spawns
`--input-format stream-json` and is. So `create_session(agent: "dev:reviwer")` would run the
wrong agent and return a plausible answer with nothing saying so — a failure that reports
itself as a success, the same class as the one this whole report is about.

Closed in `agent-availability.ts`: the roster is discovered live (spawn `claude --agent
<sentinel> -p`, parse `Available agents:` — ~0.5s, no API call, no tokens) and cached **per
cwd**, because the roster is cwd-dependent (24 names in this repo, 5 in `/tmp`). Validation
**fails open** when the roster cannot be determined, mirroring the contract `prehydrate.ts`
documents: a resolution step is an optimisation of WHERE something is checked, not a gate on
whether the spawn proceeds.

**Upstream status: do NOT wait for a fix.** The CLI reference documents neither the interaction
nor the validation. The nearest report,
[anthropics/claude-code#15815](https://github.com/anthropics/claude-code/issues/15815), was
**closed as not planned**. Verified with `claude` invoked directly (no claudish in the path), and
the same run reports `result: success` with `is_error: false` and zero mentions of the bad name
anywhere in the stream — so it is not "errors relocated into the protocol". Interactive mode
refuses the same name with the full list, which is the divergence
`ai-docs/architecture/headless-vs-interactive.md` records, and the reason magmux exists.

## 5. Known unrelated defect found on the way

Every captured response has a stray non-assistant event concatenated onto it:

```
OK
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",…},"uuid":"…"}
```

Under `captureMode: "stream-json"` the orchestrator is folding `rate_limit_event` frames
into the response text. It inflated a 2-byte answer to 191 B. It did not affect any result
here (the `requirePattern` verdicts were correct either way), but it corrupts `outputSize`
and would defeat a `min_output_bytes` threshold. Filed separately from this work.
