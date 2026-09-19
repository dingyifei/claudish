# Advisor mutation proofs (archived)

Archived on 2026-09-11 from the gitignored build session
`ai-docs/sessions/dev-feature-advisor-any-model-20260909-0001/tests/mutation-proofs.md`, which
`git worktree remove` deletes. Everything below the rule is verbatim.

Each row plants one bug, runs only the test that must catch it, and records the result. A row
marked NOT PROVEN is a guard that did not exist at that time; the "Gap-closure" section at the
end re-plants those bugs after tests were added.

Read it as a record of the build, not as a description of later code:

- Line numbers and the `git status` blocks describe the working tree during the build. The
  cited commits (`f599ce2`, `64bab36`, `4468665`) exist in history.
- Paths under `/Users/jack/.claude/jobs/` were temporary backup copies on the build machine.
  They no longer exist.
- The released code is `v9.3.0` (merge `ee2c995`). The build report is
  `advisor-build-report-20260911.md`.

---

# Mutation proofs

Method: back up the source file by copy, apply one targeted bug with `perl -pi`,
confirm with `git diff --stat` that exactly one line changed, run ONLY the
guarding test file, restore by copy (never git), confirm the restore with `cmp`.
Run by the orchestrator. Source at the time: `claude-runner.ts` identical to
commit `4468665`.

## `packages/cli/src/claude-runner-advisor.test.ts` (Codex, commit f599ce2 + 64bab36)

Unmutated: 11 pass, 0 fail.

| Id | Mutation in `claude-runner.ts` | Result | Failing tests |
|---|---|---|---|
| M3 | `isAdvisorNativeSession`: drop `&& !config.model` | 9 pass, 2 fail | `is false when a Claude model is set`; `is false when a non-Claude model is set` |
| M1 | `resolveAdvisorToolEnv`: set `"2"` instead of `"1"` | 9 pass, 2 fail | `sets the advisor variable to 1 when advisor is on and the parent variable is absent`; `uses a value accepted by Claude Code's strict boolean parser` |
| M2 | `resolveAdvisorToolEnv`: delete the inherited-value check | 9 pass, 2 fail | `preserves an inherited value of 0`; `preserves an inherited value of true` |
| M4 | `resolveAdvisorToolEnv`: advisor off still adds the variable | 10 pass, 1 fail | `does not add the advisor variable when advisor is off` |

Every mutation restored; final `git diff --stat` on source and test file: empty.

## Advisor guard mutation proofs, 14 mutations (2026-09-10)

Same method: back up by `cp` to `/Users/jack/.claude/jobs/be9663df/tmp/mut-<basename>.orig`,
run one `perl -pi` edit, confirm with `diff` against the backup that the file
changed, run ONLY the guarding test file, restore by `cp`, check with `cmp`. No
test file was touched. Paths are relative to `packages/cli/src/`.

Unmutated baselines: `handlers/advisor-routing-and-state.test.ts` 7 pass,
`handlers/advisor-decorator.test.ts` 8 pass, `claude-runner-advisor.test.ts` 19 pass,
`advisor-startup.test.ts` 18 pass. All 0 fail.

| Id | File | Mutation (perl edit) | Result | Failing tests | Verdict |
|---|---|---|---|---|---|
| 1 | `handlers/native-handler-advisor.ts` | `s/resolveModelNameSync\(rawModelId, "openrouter"\)\.resolvedId\)/resolveModelNameSync(rawModelId, "openrouter") as any)/` | 6 pass, 1 fail | `routes OpenAI, Google, OpenRouter, and Anthropic models with provider credentials` (the `typeof openrouter.wireModel` check on `grok-4.6`: expected "string", received "object") | PROVEN |
| 2 | `handlers/native-handler-advisor.ts` | `s/const keys = own === NO_SESSION_BUCKET \? \[NO_SESSION_BUCKET\] : \[own, NO_SESSION_BUCKET\];/const keys = [...pendingBySession.keys()];/` (lookup searches every bucket) | 5 pass, 2 fail | `isolates calls by session and retains consumed entries`; `adopts a no-session call into the first known session` | PROVEN |
| 3 | `handlers/native-handler-advisor.ts` | `s/^(\s*)call\.consumedAt \?\?= clock\(\);/$1call.consumedAt ??= clock();\n$1pendingBySession.get(call.sessionKey)?.delete(toolUseId);/` | 5 pass, 2 fail | `isolates calls by session and retains consumed entries`; `adopts a no-session call into the first known session` | PROVEN |
| 4 | `handlers/native-handler-advisor.ts` | `s/\(block as any\)\.is_error = true;/(block as any).is_error = false;/` | 6 pass, 1 fail | `propagates an AdvisorToolResult error flag and text` | PROVEN |
| 5 | `handlers/advisor-decorator.ts` | `s/if \(c\.get\("advisorHandled"\) === true\) return this\.inner\.handle\(c, payload\);//` | 8 pass, 0 fail | none | NOT PROVEN |
| 6 | `handlers/advisor-decorator.ts` | `s/ADVISOR_ABSENT_WARN_AFTER = 3;/ADVISOR_ABSENT_WARN_AFTER = 2;/` | 5 pass, 3 fail | `warns once after three consecutive tool-carrying requests without advisor`; `does not count or reset requests with no tools array`; `resets the consecutive count when advisor is offered and remains one-shot after warning` | PROVEN |
| 7 | `handlers/advisor-decorator.ts` | `s/if \(!Array\.isArray\(tools\) \|\| tools\.length === 0\) return;/if (!Array.isArray(tools) \|\| tools.length === 0) { consecutiveAbsent = 0; return; }/` | 7 pass, 1 fail | `does not count or reset requests with no tools array` | PROVEN |
| 8 | `handlers/advisor-decorator.ts` | `s/return new Response\(passthrough, \{/return new Response("", {/` | 7 pass, 1 fail | `returns byte-identical SSE response data to the client (BC7)` | PROVEN |
| 9 | `handlers/advisor-decorator.ts` | `s/const swapped = swapAdvisorToolInBody\(payload\);/const swapped = null as any;/` | 6 pass, 2 fail | `replaces the server advisor tool and preserves every other tool in order`; `processes a request only once when an already wrapped handler is wrapped again` | PROVEN |
| 10 | `claude-runner.ts` | `s/return value === (CLAUDISH_PLACEHOLDER_(API_KEY\|AUTH_TOKEN));/return value?.includes($1) ?? false;/` (both lines of `isClaudishPlaceholderCredential`) | 17 pass, 2 fail | `leaves values that merely contain placeholder text untouched`; `recognizes only the exact placeholder for the matching variable name` | PROVEN |
| 11 | `claude-runner.ts` | `s/for \(const name of \["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"\] as const\)/for (const name of ["ANTHROPIC_API_KEY"] as const)/` | 17 pass, 2 fail | `removes the exact auth-token placeholder and reports it`; `leaves unrelated environment variables untouched` | PROVEN |
| 12 | `advisor-startup.ts` | `s/return v === "1" \|\| v === "true" \|\| v === "yes" \|\| v === "on";/return v.length > 0;/` (in `isClaudeCodeBoolTrue`) | 15 pass, 3 fail | `does not refuse for the disable variable when the child value is "2"` / `"false"` / `"0"` | PROVEN |
| 13 | `advisor-startup.ts` | `s/if \(!facts\.collectorDefaulted\) \{/if (true) {/` | 17 pass, 1 fail | `drops an unavailable default collector and explains concatenation` | PROVEN |
| 14 | `advisor-startup.ts` | `s/if \(includesMain\.length > 0\) \{/if (true) {/` | 17 pass, 1 fail | `mentions the main model only when it is also a panel member` | PROVEN |

Why 5 is NOT PROVEN: the exactly-once test (`processes a request only once when an
already wrapped handler is wrapped again`) asserts only that the final `tools` array
holds one function `advisor` and no `advisor_20260301`. A second pass of
`swapAdvisorToolInBody` over an already-swapped body finds no server tool and
changes nothing, so double processing leaves that array the same. The duplicate
presence-monitor observation, the duplicate `swap_applied` log record and the
double response tee all go unasserted. Mutation 9 fails this test only because it
removes the swap entirely. The test was not strengthened here.

Final `git diff --stat packages/`: empty output (exit 0). `cmp` of all four source
files against their `.orig` copies: identical.

## Orchestrator spot checks (re-run independently)

| Id | Control (unmutated) | Mutated | Restored |
|---|---|---|---|
| 8 | `advisor-decorator.test.ts` 8 pass, 0 fail | 7 pass, 1 fail: `returns byte-identical SSE response data to the client (BC7)` | `cmp` identical; `git diff --stat` empty |
| 1 | `advisor-routing-and-state.test.ts` 7 pass, 0 fail | 6 pass, 1 fail: `advisorRouteFor > routes OpenAI, Google, OpenRouter, and Anthropic models with provider credentials` | `cmp` identical; `git diff --stat` empty |

## New-guard mutation proofs

Round 2, run 2026-09-11 against the working tree of `worktree-advisor-support`.
Protocol: one mutation at a time via `perl -pi -e`, applied + tested + restored in a
single command, each file backed up by `cp` to
`/Users/jack/.claude/jobs/be9663df/tmp/mut2-<basename>.orig` first. No test file was
edited. `diff -q` confirmed every edit landed; `cmp` confirmed every restore.

| Id | Source file | perl edit | Result | Failing tests | Verdict |
|---|---|---|---|---|---|
| 1 | `handlers/native-handler-advisor.ts` | `s/^function rememberAdvisorToolUseId\(id: string, sessionId\?: string\): void \{$/function rememberAdvisorToolUseId(id: string, sessionId?: string): void {\n  if (!id.startsWith("toolu_")) return;/` | `advisor-capture.test.ts` 1 pass, 4 fail | `records the parser-produced non-Anthropic advisor tool-use id`; `records the same id when parser output is split into 16-byte chunks`; `… into 64-byte chunks`; `records the same id when a chunk boundary lands on a newline inside an SSE event` | **PROVEN** |
| 2 | `handlers/native-handler-advisor.ts` | `s/^    this\.buf \+= chunkText;$/    this.buf = chunkText;/` | `advisor-capture.test.ts` 3 pass, 2 fail | `records the same id when parser output is split into 16-byte chunks`; `… into 64-byte chunks` | **PROVEN** |
| 3 | `handlers/native-handler-advisor.ts` | `s/^    if \(typeof text !== "string" \|\| text\.trim\(\)\.length === 0\) \{$/    if (typeof text !== "string") {/` | `advisor-failures.test.ts` 4 pass, 1 fail | `treats an HTTP 200 response with an empty answer as a failure` | **PROVEN** |
| 4 | `handlers/native-handler-advisor.ts` | `s/^    reason: sanitizeAdvisorReason\(reason, secrets\),$/    reason,/` | `advisor-failures.test.ts` 4 pass, 1 fail | `redacts credential-shaped provider text while preserving the reason` | **PROVEN** |
| 5 | `handlers/native-handler-advisor.ts` | `s/^    origin: "stub",$/    origin: observed?.status === 400 ? "upstream" : "stub",/` | `advisor-failures.test.ts` 1 pass, 4 fail | `turns an HTTP 400 panel response into a named stub failure`; `preserves successful advice and reports a failed peer without a collector`; `raises exactly one warning for a failed call and names every failed model`; `redacts credential-shaped provider text while preserving the reason` | **PROVEN** |
| 6 | `handlers/native-handler-advisor.ts` | `s/^      if \(block\.type === "tool_result" && block\.tool_use_id === toolUseId\) \{$/      if (block.type === "tool_result" && JSON.stringify(block.content ?? "").includes("No such tool available")) {/` | `advisor-panel-prompt.test.ts` 4 pass, 1 fail | `preserves another tool result verbatim even when it quotes the plumbing error` | **PROVEN** |
| 7 | `handlers/native-handler-advisor.ts` | ``s/^    `\$\{body\}\\n\\n` \+$/    "" +/`` | `advisor-panel-prompt.test.ts` 4 pass, 1 fail | `turns an empty advisor input into usable panel instructions` | **PROVEN** (see note) |
| 8 | `handlers/native-handler-advisor.ts` | `s{^  return entry\.sources\["openrouter-api"\]\?\.externalId \?\? null;$}{  const fromOr = …; if (fromOr) return fromOr; for (const s of Object.values(entry.sources) as any[]) { const id = s?.externalId; if (typeof id === "string" && id.includes("/")) return id; } return null;}` | all four advisor guard files: 22 pass, 0 fail | none | **NOT PROVEN** |
| 9 | `handlers/native-handler-advisor.ts` | `s/^  if \(route\.kind !== "openai"\) return "max_tokens";$/  return "max_tokens";/` | all four advisor guard files: 22 pass, 0 fail | none | **NOT PROVEN** |
| 10 | `handlers/advisor-decorator.ts` | `s{^    if \(c\.get\("advisorHandled"\) === true\) return this\.inner\.handle\(c, payload\);$}{    // mutation: already-wrapped guard removed}` | `advisor-decorator.test.ts` 8 pass, 1 fail | `withAdvisorSwap > observes advisor presence only once per request through nested wrappers` | **PROVEN** |
| 11 | `advisor-startup.ts` | `s/^      callable: false,$/      callable: true,/` | `advisor-startup.test.ts` 18 pass, 0 fail | none | **NOT PROVEN** |
| 12 | `handlers/shared/stream-parsers/openai-sse.ts` | `s/^export const SSE_LOG_MAX_CHARS = 1_000_000;$/export const SSE_LOG_MAX_CHARS = 300;/` | `format-translation.test.ts` 97 pass, 0 fail | none | **NOT PROVEN** |

### Notes on the individual results

**7 — the question IS guarded, but not by the test that names it.**
`states the advisor question in the messages sent to the panel` asserts only that
`JSON.stringify(prepared)` contains the question string. The advisor `tool_use` block is
copied through unchanged and still carries `input.question`, so that assertion holds even
when the appended final user turn is emptied. The mutation was caught instead by
`turns an empty advisor input into usable panel instructions`, which asserts on the
content of the final turn itself. The behaviour is guarded; the guard is the empty-input
test, not the question test.

**5 — origin is a load-bearing field across the whole failure surface.**
The mutation was scoped to HTTP 400 alone and still took out four of the five tests: the
warning aggregation, the peer-failure reporting and the redaction test all read `origin`
to decide what counts as a failure. That is the intended coupling, not over-reach.

**8 — the Fireworks-id bug is not re-detectable by the current tests.**
`advisorRouteFor` is exercised only for `grok-4.6`, whose live catalog entry does carry an
`openrouter-api` external id, so the reintroduced "any slashed external id" fallback is
never reached. Reproducing the shipped bug needs a model the catalog knows but OpenRouter
does not serve (the `kimi-k3` case the comment at `openRouterIdOf` documents), with a
fixture catalog entry whose only slashed id belongs to another vendor. Coverage gap.

**9 — the token-parameter spelling has no test at all.**
`grep -rn "max_completion_tokens\|advisorTokenParamFor" packages/cli/src --include="*.test.ts"`
returns nothing. Forcing the deprecated `max_tokens` on the openai route — exactly the
400 the doc comment cites twice from runs phase7b-B and phase7b-C — is invisible to the
suite. Coverage gap.

**10 — the new nested-wrapper test is the one that catches it.**
The older test `processes a request only once when an already wrapped handler is wrapped
again` still PASSED under the mutation: it observes the inner handler's call count, and a
double-wrapped handler still reaches the inner handler once per outer call. Only
`observes advisor presence only once per request through nested wrappers`, which shares a
single presence monitor between two wrappers and counts observations, fails. Without that
test the `advisorHandled` guard is unguarded.

**11 — `unresolvedAlias` short-circuits nothing the tests look at.**
No test file in `packages/cli/src` references `advisorModelStatus` or `unresolvedAlias`
(`grep -rln` over the tree returns only source files). The startup tests drive refusals
through missing credentials only, so flipping the alias branch to `callable: true` changes
no assertion. Coverage gap.

**12 — the SSE log truncation is exercised by no test.**
`SSE_LOG_MAX_CHARS` / `formatRawSseLogPayload` are referenced only by `openai-sse.ts` and
`openai-responses-sse.ts`. `format-translation.test.ts` mentions `extract-sse-from-log.ts`
in a header comment only; it replays checked-in `.sse` fixtures and never writes or reads a
debug log. The 300-char cap can be reintroduced with a fully green suite — the corruption
would resurface only as a wrong `stop_reason` in a future fixture extraction, which is
precisely the failure mode the constant's doc comment describes. This is the widest of the
four gaps: the regression it protects against is silent by construction.

### Final state

```
$ git status --porcelain packages/
 M packages/cli/src/advisor-startup.ts
AM packages/cli/src/handlers/advisor-capture.test.ts
M  packages/cli/src/handlers/advisor-decorator.test.ts
A  packages/cli/src/handlers/advisor-failures.test.ts
 M packages/cli/src/handlers/native-handler-advisor.ts
 M packages/cli/src/handlers/shared/stream-parsers/openai-responses-sse.ts
 M packages/cli/src/handlers/shared/stream-parsers/openai-sse.ts
 M packages/cli/src/index.ts
 M packages/cli/src/test-fixtures/extract-sse-from-log.ts
 M packages/cli/src/test-fixtures/sse-responses/grok-4.6-openai-advisor-turn1.sse
?? packages/cli/src/handlers/advisor-panel-prompt.test.ts
```

Byte-identical to the status recorded before the first mutation. All four backups verified
against their live files with `cmp` after the last run:
`native-handler-advisor.ts`, `advisor-decorator.ts`, `advisor-startup.ts`,
`openai-sse.ts` — all identical. No mutation left behind, no test file touched.

## Gap-closure mutation proofs

Re-run of the four bugs that were NOT caught the last time they were planted. Tests have since
been added for each; this round re-plants the same bugs to prove those tests are real guards.
Every bug below was an observed production failure, not a hypothetical.

| # | Bug | Source file | Exact perl edit | Result | Failing test(s) | Verdict |
|---|-----|-------------|-----------------|--------|-----------------|---------|
| 1 | OpenRouter wire id falls back to any external id containing a slash (the old behaviour that put `accounts/fireworks/models/kimi-k3` on the wire to OpenRouter) | `packages/cli/src/handlers/native-handler-advisor.ts` (`openRouterIdOf`) | `perl -pi -e 's{return entry\.sources\["openrouter-api"\]\?\.externalId \?\? null;}{return entry.sources["openrouter-api"]?.externalId ?? ((Object.values(entry.sources ?? {}) as any[]).map((s) => s?.externalId).find((id) => typeof id === "string" && id.includes("/")) ?? null);}'` | 12 pass / **1 fail** | `OpenRouter advisor wire-model resolution > refuses a known model that only publishes another vendor's external id` | **PROVEN** |
| 2 | `max_tokens` sent on the direct OpenAI route (`HTTP 400: Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.`) | `packages/cli/src/handlers/native-handler-advisor.ts` (`advisorTokenParamFor`) | `perl -pi -e 's{if \(route\.kind !== "openai"\) return "max_tokens";}{if (true \|\| route.kind !== "openai") return "max_tokens";}'` | 12 pass / **1 fail** | `advisor request token parameter routing > uses max_completion_tokens on the direct OpenAI route` | **PROVEN** |
| 3 | An unresolved collector alias is treated as callable (claudish would POST the claudish alias verbatim and take a silent 401/404) | `packages/cli/src/advisor-startup.ts` (`advisorModelStatus`) | `perl -pi -e 's!if \(route\.unresolvedAlias\) \{!if (false && route.unresolvedAlias) {!'` | 20 pass / **3 fail** | `decideAdvisorStartup > unresolved collector aliases > keeps an unresolved alias uncallable even when its credential is present`; `... > refuses an unresolved collector named by the user`; `... > drops an unresolved default collector and explains concatenation` | **PROVEN** |
| 4 | The 300-character truncation of the logged raw SSE payload returns (cut mid-JSON, so extracted fixtures fail `JSON.parse` and the corruption only ever surfaces as a wrong `stop_reason`) | `packages/cli/src/handlers/shared/stream-parsers/openai-sse.ts` (`SSE_LOG_MAX_CHARS`) | `perl -pi -e 's!export const SSE_LOG_MAX_CHARS = 1_000_000;!export const SSE_LOG_MAX_CHARS = 300;!'` | 2 pass / **1 fail** | `formatRawSseLogPayload > preserves a realistic payload well beyond the former 300-character cap` | **PROVEN** |

Guard files (unchanged by this round):
`packages/cli/src/handlers/advisor-routing-and-state.test.ts` (#1, #2),
`packages/cli/src/advisor-startup.test.ts` (#3),
`packages/cli/src/handlers/shared/stream-parsers/sse-log-payload.test.ts` (#4).

Note on #4: the other two tests in `sse-log-payload.test.ts` derive their expectations from the
exported `SSE_LOG_MAX_CHARS`, so they follow the constant wherever it is set and cannot catch a
shrunken cap. The guard is the first test, which pins a literal 5,000-character payload against
the former 300-character cap. That test alone carries the proof, and it does fail.

Protocol notes: each mutation was applied, tested and restored inside a single command; `diff -q`
confirmed the edit landed before every test run, and `cmp` confirmed the restore after it. No test
file was edited, and no `git stash` / `checkout` / `restore` / `reset` was used at any point (this
tree carries uncommitted work). Mutation 3's first attempt aborted on a perl delimiter error
(`s{...}{...}` with an unbalanced `{` in the replacement) — the `&&` short-circuited before `diff`,
so the file was never mutated on that attempt; it was re-run with `!` delimiters.

### Final state

```
$ git status --porcelain packages/
 M packages/cli/src/advisor-startup.test.ts
 M packages/cli/src/advisor-startup.ts
AM packages/cli/src/handlers/advisor-capture.test.ts
M  packages/cli/src/handlers/advisor-decorator.test.ts
A  packages/cli/src/handlers/advisor-failures.test.ts
 M packages/cli/src/handlers/advisor-routing-and-state.test.ts
 M packages/cli/src/handlers/native-handler-advisor.ts
 M packages/cli/src/handlers/shared/stream-parsers/openai-responses-sse.ts
 M packages/cli/src/handlers/shared/stream-parsers/openai-sse.ts
 M packages/cli/src/index.ts
 M packages/cli/src/test-fixtures/extract-sse-from-log.ts
 M packages/cli/src/test-fixtures/sse-responses/grok-4.6-openai-advisor-turn1.sse
?? packages/cli/src/handlers/advisor-panel-prompt.test.ts
?? packages/cli/src/handlers/shared/stream-parsers/sse-log-payload.test.ts
```

Byte-identical to the status recorded before the first mutation of this round. Each backup was
verified against its live file with `cmp` after the last run:

```
IDENTICAL native-handler-advisor.ts
IDENTICAL advisor-startup.ts
IDENTICAL openai-sse.ts
```

No mutation left behind, no test file touched.
