# Handoff: four follow-ups from the any-model advisor work

## Context
- Repo: MadAppGang/claudish. `--advisor` for any main model shipped in v9.3.0 (merge ee2c995).
- Prerequisite: this file, the roadmap entries and the archives (commit fe0bd29 and the commit
  that adds this file) are on main.
- Read first: CLAUDE.md (the Invariants section is binding), ai-docs/architecture/advisor.md,
  ai-docs/architecture/adapters.md.
- Evidence from the original build, in ai-docs/reports/: advisor-build-report-20260911.md,
  advisor-mutation-proofs-20260911.md, advisor-scope-decisions-20260910.md,
  advisor-any-model-verification-20260911.md.
- Each item has a ROADMAP.md entry with the full rationale. This file is the work order.

## Working rules
1. Work in a new worktree from current main (/dev:worktree). Never use git stash in a worktree.
2. Before any edit, run `bun run test`. Record the counts and the names of the failing tests.
   On bun 1.4.0, the two displayWidth tests in packages/cli/src/tui/viz/color.test.ts fail.
   Any other failure after your change is a regression.
3. Tests: Codex writes them, a subagent runs them, you check the result with a real claudish run.
4. Run claudish in a dedicated session (/terminal:run or a channel session), not in the main Bash tool.
5. Fixtures come from real debug logs (`claudish --debug` writes to logs/). Never hand-craft one.
6. Every new guard needs a mutation proof: copy the source file aside, plant the bug, run only
   the guarding test, show that it fails, restore by copy (never git), check with cmp.
   Record the proof in ai-docs/reports/.
7. "Done" needs pasted output from a fresh run. Anything that must survive goes in a tracked
   directory, never ai-docs/sessions/.

## Order
4, 3, 2, 1: smallest and safest first. Items 4 and 3 are independent. Item 2 needs a real
capture first. Item 1 is the only large one.

## Item 4: local `bun run test` skips the macOS bridge suite (small)
Roadmap: "Local `bun run test` skips the macOS bridge suite".
Problem: package.json:23 joins the two suites with &&. On bun 1.4.0 the CLI suite is red, so the
bridge suite never runs locally. CI pins bun 1.3.10 (.github/workflows/test.yml:58, :97), is
green, and runs both suites.
Do: make the root test script run both suites every time and exit non-zero if either failed.
Write it as a small Bun + TypeScript script, not shell logic.
Done when: on bun 1.4.0, `bun run test` prints both "Ran N tests across M files" lines (the
bridge line is "20 tests across 1 file") and exits 1; the PR's CI run is green and shows both.
Out of scope: the displayWidth failures (a bun-version drift, separate task).

## Item 3: the openai-sse parser drops per-chunk errors (small to medium)
Roadmap: "`openai-sse` parser: one `catch` drops every per-chunk error without a log line".
Problem: packages/cli/src/handlers/shared/stream-parsers/openai-sse.ts. The try opens at :534
with JSON.parse(dataStr) and closes at :896 with `} catch (e) {}`. An exception anywhere in those
360 lines (usage, text, reasoning, tool calls) disappears. A tool call can vanish while the turn
ends with end_turn. The catches at :267 and :270 are correct; leave them.
Do: log the error in that catch, with enough context to find the chunk in a debug log (the raw
chunk is already logged at :528). Optionally narrow the try to the parse. One bad chunk must
still not end the stream.
Done when: a test takes a real fixture from packages/cli/src/test-fixtures/sse-responses/,
corrupts one data line, and asserts that the error is logged and the stream continues; removing
the log call makes that test fail; format-translation.test.ts stays green.
Trap: this is the default stream format for every adapter that does not override it
(packages/cli/src/adapters/base-api-format.ts:605). Run all stream-parser tests, not one file.

## Item 2: a reasoning-only panel reply is recorded as a stub (small)
Roadmap: "`--advisor`: a reasoning-only panel reply is recorded as a stub".
Problem: extractChatCompletionText (packages/cli/src/handlers/native-handler-advisor.ts:2179-2187)
reads only choices[0].message.content. A reply whose text is only in a reasoning field reaches
the check at :2152 and becomes origin: "stub".
Decide first, with the user: does reasoning without a final answer count as advice? If no, only
improve the failure reason. If yes, continue.
Do: run a reasoning model as a panel member with `claudish --debug`, capture a real
reasoning-only response, build the fixture from that log, and read the field that response uses.
Done when: the fixture test passes; a reply with no text at all is still a stub; the
advisor_call record shows when reasoning was accepted as advice; a mutation proof exists; one
real run with that panel model shows origin "upstream" in the advisor log.

## Item 1: panel calls skip subscription-aware routing (medium to large)
Roadmap: "Route `--advisor` panel calls through subscription-aware routing".
Problem: advisorRouteFor (packages/cli/src/handlers/native-handler-advisor.ts) calls each panel
model with a raw metered key: OPENAI_API_KEY to api.openai.com, GEMINI_API_KEY, ANTHROPIC_API_KEY
for a Claude collector, OPENROUTER_API_KEY for the rest. It never calls route(). Example:
preflight routes gpt-5.6-sol to the Codex subscription (cx@) and grok-4.6 to the Grok
subscription (gk@), but as panel members both bill per token.
Read first: advisor.md, section "Panel routing and billing".
Must still hold: origin records separate "upstream" from "stub" per model; billing is decided by
the credential that signed (RequestAuth.arm === "oauth"), never by the provider name; the startup
refusal and notice read the same single routing function as the runtime.
Traps, each one silent:
- The default collector is haiku, a bare Claude name. It must never reach route(). Check
  nativeRouteFor() first, or the routing chain falls back to OpenRouter.
- openai-codex bills by the signing credential. It is in CREDENTIAL_DECIDED_PROVIDERS and must
  never also be in SUBSCRIPTION_PROVIDERS.
- An absent arm means metered. "The composite returned an artifact" does not mean subscription.
- Never hardcode rosters or pricing. Resolve them live.
Done when: a real run of
  claudish --model grok-4.6 --advisor "gpt-5.6-sol,grok-4.6" -p "<task>"
writes, for each panel member, an advisor_call record with origin "upstream" and the
subscription route host (add a billing field to the record, which it does not have today); the
startup notice no longer says "billed per token" for those members; a member with no
subscription still bills metered and says so; preflight and the startup notice agree for every
member.

## When finished
Mark each ROADMAP.md item DONE with its evidence (follow the format of the entry
"Regression test: a Responses stream that dies mid tool-call"), update advisor.md for items 1
and 2, and record the mutation proofs in ai-docs/reports/.
