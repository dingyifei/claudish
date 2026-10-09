# Phase 7 — validation results

> **Ported 2026-09-19** from branch `worktree-qwen-token-plan` (`1e5e157`) onto `eceab30`.
> These are that branch's results, not a run of HEAD. Provider names, shortcuts,
> variables and labels are translated to HEAD's everywhere, including inside quoted
> commands and output, so quoted material is not byte-verbatim. The metered-fallback
> billing gate's validation (V3 on that branch) is removed, because HEAD does not carry
> the gate. At HEAD a bare `qwen3.*` chain starts with the Alibaba Coding Plan when
> `QWEN_CODING_PLAN_API_KEY` is set, so V4's chain would gain a first row on a machine
> holding that key.

Run 2026-09-18 against the **repo build** (`packages/cli/dist/index.js`, `bun run build`),
not the global binary. That distinction matters: `preflight` through the claudish MCP
server runs the **released** global install, so an after-comparison there would
re-measure v9.4.0 and report no change whatever was implemented.

Commit under test: `6b627f1`. Suite: **3657 pass / 19 skip / 0 fail** across 237 files.

---

## V6 — end-to-end run — **PASS**, with log evidence

Command (run in an isolated pane, per the project rule against running claudish in the
main shell):

```
bun run packages/cli/dist/index.js --model qtoken@qwen3.7-plus --debug -p "Reply with exactly: VALIDATION_OK"
```

Output: `VALIDATION_OK`

Debug log `~/.claudish/logs/claudish_2026-09-17_17-25-13.log`:

```
[Proxy] Handler: provider=qwen-token-plan, model=qwen3.7-plus
[Proxy] Created qwen-token-plan handler (composed): qwen3.7-plus
[Alibaba Token Plan] Response status: 200
```

Two things proven here, not inferred:

1. The request was served by **`qwen-token-plan`** — the subscription — and returned 200.
2. The log line says **"Alibaba Token Plan"**. The naming fix reaches the **live request
   path**, not merely a display surface. This is the defect that started the task:
   previously one entry called itself "Qwen Plan" while linking users to Coding Plan
   documentation.

## V4 — back-compat — **PASS**

`providers` through the repo build:

```
✓ qwen-token-plan      env
· qwen-payg            —
```

`qwen-token-plan` resolves (the Keychain write-through is classified `env` by design, per
`ai-docs/architecture/keychain.md`); `qwen-payg` is correctly unconfigured, since no
`DASHSCOPE_API_KEY` exists on this machine.

`--probe qwen3.8-max` returns the designed chain order:

```
1  Alibaba Token Plan  qtoken@qwen3.8-max
2  OpenCode Zen Go     zengo@qwen3.8-max
3  Alibaba PAYG        qpay@qwen3.8-max
4  OpenRouter          accounts/fireworks/models/qwen3p8-max
```

Subscription first, metered after — unchanged from the before-snapshot in
`before-routing.md`, and the display name is now correct.

### One result that needed a control before it could be read

`--probe` reports `○ missing` for `qtoken@qwen3.7-plus` even though the credential resolves.
That looks like a regression from the credential work, so it was checked against the
**released v9.4.0 binary**, which predates every change here:

```
qtoken@qwen3.7-plus   qwen-token-plan · 0/1 live      ○ missing
```

Identical. This is **pre-existing** and explained in `keychain.md`: `describeSourceSync`
decides the readiness dot and **cannot await**, so a keychain-only provider renders as
unconfigured while working perfectly at request time — which V6 above demonstrates.

Without that control the finding would have been reported as a regression this change
introduced.

## V5 — TUI — **PASS on its stated purpose, PARTIAL on coverage**

The config TUI was driven in a tmux pane and rendered as PNG (not text capture), because
the failure this check exists to catch — a module-level `const` snapshotting the palette
before theme detection runs — is invisible to text.

Rendered correctly: tab bar, provider table, status/auth columns, the detail panel and
the key legend, with theme colours applied live.

**Partial:** the Alibaba rows sit below the not-configured divider (same
`describeSourceSync` limitation as above) and the list is clipped at this pane height.
`PageDown` is not bound and stepping there would have taken ~15 further round trips, so
the naming was verified through the `providers` listing instead. The palette question —
V5's actual purpose — is answered.

Evidence: screenshots captured in-session; navigation confirmed working (selection moved
Antigravity → Devin under a single `Down`).

## V1 — live silo behaviour — **PASS**

Proven live at the start of this work and unchanged by it:

| Host | Credential | Result |
|---|---|---|
| `token-plan…` | stored key | **200** (and again in V6 above) |
| `coding-intl…/v1/models` | none, bogus, real | **200 with no key** — unauthenticated, never entitlement evidence |
| `dashscope-intl…` | Token Plan key | **401** `Incorrect API key provided` |

## V2 — capability filtering — **PASS**, covered by a tracked test

`packages/cli/src/providers/transport/chat-capability.test.ts` asserts all 25 live Token
Plan ids and all 10 Coding Plan ids classify correctly, and that the three `happyhorse-*`
video ids are **not** chat. Reverting the video patterns reddens 14 tests naming exactly
those three ids.

This began as a probe in the gitignored session directory; it was promoted to a tracked
test precisely so the guard survives the worktree. That test file is not carried to
HEAD; HEAD has the video name patterns themselves (`providers/transport/probe-discovery.ts`).

---

## NOT verified, and reported as such

**The Coding Plan request path is UNVERIFIED — its AUTHENTICATION, not its route.** Since
`0ba1bfa` the product has its own provider entry (`qcode@` → `qwen-coding`,
`QWEN_CODING_PLAN_API_KEY`, discovery on `/v1/models`), so it is **built**. It is also **verified-reachable**, probed 2026-09-18: a bogus key sent
to `coding-intl…/apps/anthropic/v1/messages` draws that host's own wording, `invalid
access token or token expired`, where `token-plan…` answers `Invalid API-key provided.`
The host that answers identifies itself.

**Entitled is the state still missing.** No Coding Plan key exists, and the user reports
none is purchasable. Measured 2026-09-17: the stored `sk-sp-` key is rejected by
`coding-intl` byte-identically to a fabricated key, across both API surfaces and all
three header shapes, with a passing control on the Token Plan host proving the probe
discriminates. Nothing in this change claims that path works — and nothing here says the
plan was unreachable before `0ba1bfa`, because the documented Token Plan base-URL
override did reach it.

**The blank-`BASE_URL` guard is dead code** — found by the black-box tests, quarantined
at `ai-docs/reports/blackbox-tests-alibaba/quarantine/`. `resolveBaseUrl` treats `""` as
unset, so the `unreachable` branch the design lists as fixed cannot be reached by any
provider with a static `baseUrl`. A claimed fix that does not work. The same holds at HEAD.

**R11 capability-aware selection: PARTIALLY MET.** The video gap is closed by name
patterns; no authoritative capability source exists for an arbitrary id, because
`ModelDoc.capabilities` has no `video` key. Bug report filed for models-index.

**R8 completeness: DETECTED, NOT PROVEN.** Alibaba publishes no total, no pagination and
no continuation signal. Now less consequential than at design time: nothing is persisted,
so an undetectably partial response cannot overwrite accepted state — it can only fail to
confirm, and a non-fresh result denies nothing.
