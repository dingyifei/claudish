# Independent validation of `2026-09-04-claudish-preflight-not-the-agents-job.md`

Validated 2026-09-04 against the live repo (worktree `team-fix2`, base `acf18bb`) and
against `~/.claude/projects/**/*.jsonl` re-counted with a JSON parser, not grep.

Method note: the plan's verify command greps for `"name":"…","input"`. This validation
instead parses every transcript line as JSON and counts only content blocks whose `type`
is exactly `tool_use`. Two independent methods, same numbers.

Scripts: `count-claudish-calls.ts`, `seq.ts` (in this directory).

## Claim-by-claim

| # | Plan claim | Result | Evidence |
|---|---|---|---|
| 1 | Target file is `packages/cli/src/mcp-server.ts` | CONFIRMED | file exists, 2109 lines |
| 2 | `:942` preflight description says "Call this before `team` or a batch of `create_session` calls…" | CONFIRMED verbatim | lines 936-942 |
| 3 | `:745` search_models says "…call `preflight` for that." | CONFIRMED verbatim | line 745 |
| 4 | `:848` result footer says "…call `preflight({models: ["X"]})`. This listing cannot answer that." | CONFIRMED verbatim | lines 845-848 |
| 5 | "5 preflight calls in 3 days" | CONFIRMED exactly | 5 in last 3 days |
| 6 | each `probe: true`, roster 3-5 models, `timeout_ms: 20000` | MOSTLY CONFIRMED | 4/5 have `timeout_ms: 20000`; 1 (nok3, 2026-09-01) sent no `timeout_ms` at all. Rosters 3-5. All `probe: true`. |
| 7 | probe loop at `:1005` is sequential | CONFIRMED | `for (const model of models)` at line 1004-1006, awaits `route()` per iteration |
| 8 | "Zero in magus" | CONFIRMED | no magus project appears in any preflight invocation, all time |
| 9 | One models-index session: `list_models, preflight, preflight, search_models ×5, preflight, preflight` | CONFIRMED exactly, call for call | `0a180476-….jsonl`, 10 calls, identical order |
| 10 | magus `claudish-usage` SKILL.md mentions preflight exactly once, at `:473`, inside a code block, never instructing a call | CONFIRMED | `grep -c` = 1; line 473 is `preflight()  // runtime readiness check` |
| 11 | "Over 14 days, across 5 projects" | PARTIALLY CONFIRMED — count is off | 14-day window holds 9 calls across **3** projects (madbench 4, models-index 4, claudish-nok3 1). passflow's single call is 2026-08-20, i.e. 15 days ago, just outside the window. All-time total is 10 calls across **4** distinct projects, not 5. |

Claim 11 is the only numeric error, and it does not change the argument: the behaviour is
real, recent, repeated, and absent from magus.

## Finding NOT in the plan: a fourth preflight directive at `:818`

`grep -n preflight packages/cli/src/mcp-server.ts` returns a site the plan does not list.
Inside the **zero-results** branch of the `search_models` handler:

```
"This searched OpenRouter's listing only. Subscription wire ids and catalog " +
"aliases are not in it, so this is not proof the name is unroutable. Call " +
"`list_models` for the recommended set, or `preflight` to test a specific name " +
"against real routing.",
```

Why it matters:

- It is a directive ("Call … `preflight` to test a specific name against real routing"),
  and it hands the agent exactly the routing vocabulary the plan's contract forbids.
- Edit 3 deletes the same directive from the **success** branch of the same handler
  (`:848`). The plan therefore already accepts that result strings count, not only tool
  descriptions. `:818` is the symmetric case that was missed.
- Exposure differs, and is lower: a tool description sits in context every turn, while
  `:818` only appears after a search returns nothing. But that is also the moment the
  agent is least certain and most likely to act on a suggestion.

`:818` is not in the plan's "Explicitly out of scope" list. It reads as an oversight, not
a decision. Scope call belongs to the user.

## Verdict

The plan's diagnosis is sound and its three quoted edit sites are accurate to the
character. One numeric claim (project count) is slightly overstated. One additional edit
site exists that the plan's own stated contract would require changing.
