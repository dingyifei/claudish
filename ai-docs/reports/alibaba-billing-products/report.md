# Report — Alibaba Cloud billing products as distinct products

> **Ported 2026-09-19** from branch `worktree-qwen-token-plan` (`1e5e157`) onto `eceab30`.
> This is that branch's report, not a report on HEAD. Provider names, shortcuts,
> variables and labels are translated to HEAD's everywhere, including inside quoted code
> and output, and the retired term for a per-credential model list is now *dynamic models
> catalog*. Quoted material is therefore not byte-verbatim. Passages about the
> metered-fallback billing gate, which HEAD does not carry, are removed.
>
> **What differs at HEAD.** `qwen-coding` leads both bare Qwen routing chains (`qwen3.*`,
> `qwen3-*`); on that branch it was explicit access only. So R9 below does not hold at
> HEAD: for a user holding `QWEN_CODING_PLAN_API_KEY`, the public `coding-intl…/v1/models`
> list is fetched and read as the account's answer. HEAD keeps the discovery result as a
> bare list with a five-minute in-memory TTL, not the three-state status and few-second
> memo described below. Three-valued credential readiness is not in HEAD.

Branch `worktree-qwen-token-plan`, eight signed commits from baseline `b7a7868`.
Depth: full · Automation: autonomous · Session `dev-feature-alibaba-subscript-20260917`.

**Read the "not done" section before treating anything here as finished.**

---

## What the request asked for, and what it turned out to be

The request said claudish supported Token Plan but lacked Coding Plan support. The code
said the opposite. Both readings were half right, and the reason was the defect:

```
name:        "qwen-token-plan"
displayName: "Qwen Plan"                                  ← names neither product
baseUrl:     "token-plan.ap-southeast-1.maas.aliyuncs.com" ← Token Plan host
apiKeyUrl:   ".../model-studio/claude-code"               ← Coding Plan documentation
```

One provider entry wore both products' clothes. A user following that link believed they
had configured the Coding Plan; their requests went to Token Plan. The work therefore
became *make the products distinct*, not *add a provider*.

## Commits

Six of the branch's eight commits. The other two belong to work not carried to HEAD.

| SHA | Scope |
|---|---|
| `c0ac7d8` | product naming, eligibility, capability, credential readiness, error clarity |
| `fe8722e` | stop persisting the dynamic models catalog (−429 lines) |
| `83f9afb` | rename the retired term to *dynamic models catalog* (71 files, behaviour identical) |
| `6b627f1` | black-box tests written without sight of the implementation |
| `80ff29b` | record what was measured and what is still unverified |
| `0ba1bfa` | three products, three credentials, three providers — `qwen-coding` added |

All verify `G` (good signature).

## Tests

| Point | pass | skip | fail |
|---|---:|---:|---:|
| Baseline, before `bun install` | 3119 | 17 | **17** |
| Baseline, after `bun install` | 3417 | 19 | 0 |
| Final | **3657** | 19 | **0** |

The first baseline was environmental: this worktree had **no `node_modules`**, so Bun was
resolving from the main checkout. Taking it at face value would have blamed 17 phantom
failures on this feature.

## Requirements

| # | Requirement | Status |
|---|---|---|
| R1 | Four products named distinctly end to end | **Met** — verified in the live request path: `[Alibaba Token Plan] Response status: 200` |
| R2 | Eligibility from live per-account data, never pinned | **Met** — no pinned model list in `src/`; the dynamic models catalog is never persisted |
| R3 | Individual and Team coverage distinct | **Met by construction** — per-seat keys mean coverage is per-credential; nothing is cached across identities |
| R4 | Subscription-first selection | **Met** — chain order verified through the repo build |
| R5 | User can tell which product serves a request | **Met** — provider and billing named in probe, preflight and logs |
| R6 | Clear explanation for credential / quota / unsupported / uncertain | **Met** — four distinct hints; silo-isolation clause driven by `siblingKeyEnvVars` |
| R8 | A failed refresh preserves accepted state | **Met differently than specified** — nothing is stored, so a failed refresh *denies nothing*. Stronger than remembering |
| R9 | Public availability never implies entitlement | **Met on that branch** — `coding-intl/v1/models` is unauthenticated and was used nowhere as evidence. Not true at HEAD (see the note at the top) |
| R10 | Stock shortage cannot erase coverage | **Met** — no availability signal gates a configured subscription |
| R11 | Capability-aware selection | **PARTIALLY MET** — see below |
| R12 | Existing Token Plan and PAYG setups keep working | **Met** — verified live, unchanged from the before-snapshot |

## NOT done, and why — read this section

**The Coding Plan request path is UNVERIFIED — its AUTHENTICATION, not its route.** A
dedicated provider now exists (`0ba1bfa`): `qcode@` → `qwen-coding`, with
`QWEN_CODING_PLAN_API_KEY`, `modelDiscovery.path: "/v1/models"` and membership in
`SUBSCRIPTION_PROVIDERS`. The route is **verified-reachable**, probed 2026-09-18:
`coding-intl…/apps/anthropic/v1/messages` rejects a bogus key in its own wording,
`invalid access token or token expired`, where `token-plan…` says `Invalid API-key
provided.` — so the reply identifies which host served it. Entitlement is the open half.
No key exists and none is purchasable; measured 2026-09-17, the stored `sk-sp-` key is
rejected by `coding-intl` byte-identically to a fabricated key, across both API surfaces
and all three header shapes, with a passing control on the Token Plan host proving the
probe discriminates. Nothing here claims a request on that path succeeds — reachable is
not entitled.

**The blank-`BASE_URL` guard is dead code — a fix this branch CLAIMED and does not have.**
`resolveBaseUrl` treats `QWEN_TOKEN_PLAN_BASE_URL=""` as unset and falls back to the
vendor host, so the `unreachable` branch the design lists as fixed cannot be reached by
any provider with a static `baseUrl`. Found by the black-box tests, confirmed live,
quarantined with its test and failure at `ai-docs/reports/blackbox-tests-alibaba/quarantine/`.
Not repaired because empty-means-unset affects every provider and every base-URL
variable. The same holds at HEAD.

**R11 is PARTIALLY MET.** The video gap is closed by name patterns
(`happyhorse-1.1-t2v/i2v/r2v` were classified as chat). No authoritative capability
source exists for an arbitrary id: `ModelDoc.capabilities` has no `video` key. A bug
report was filed for models-index on that branch; it is not carried here.

**Two HIGH code-review findings are deferred**, each with 1-of-4 reviewer support and
contested by others: catalog-sourced denial overriding non-fresh per-account evidence
(its fix rewrites a test three reviewers call a correct control), and the dynamic models
catalog memo key taking a display label rather than credential provenance (its fix needs
provenance the credential authority does not return). The mechanisms were recorded in
that branch's code-review consolidation, which is not carried here.

**Known residuals declared by implementers**: `auth/antigravity-token.ts`'s
`defaultReadStore` still collapses a locked keychain into `null`, as do the devin and
grok file readers.

## Review gates

- **plan-review round 1: FAIL** (6 CRITICAL). Revised.
- **plan-review round 2: FAIL** (6 CRITICAL, 8 HIGH). Revision limit reached.
- **plan-review: OVERRIDDEN BY THE USER.** Shown the surviving findings and the option to
  ship only the uncontested half, the user chose to implement in full. **This is not a
  passed gate.**
- **code-review: FAIL** (1 CRITICAL, 5 HIGH merged). The CRITICAL and 3 HIGHs fixed.
- **Two reviewers graded against their own thresholds**, including the internal reviewer,
  which returned PASS on 1 HIGH (dispatched rule: CONDITIONAL), enumerated its findings
  twice with inconsistent counts, and lost the body of one finding. **That PASS was quoted
  to the user before this was known; it is retracted.**

## What the process actually caught

**The multi-model plan gate** found that the first credential fix was *relocated, not
resolved*: `describeReadiness()` produced `"failed"` only on a throw, in modules
annotated "NEVER THROWS". The type was honest; the third state was unreachable.

**The black-box tests** — written by a model that never saw the implementation — found
defects that four reviewers and 125 self-written tests missed, among them the dead
blank-`BASE_URL` guard above, and classified **zero** tests as "wrong". Where they
disagreed with the code, the code was wrong.

## One fact that outlives this task

**`grep` silently under-reports in this repo.** `providers/model-resolvers/devin.ts` and
`adapters/grok-effort-support.ts` contain literal NUL bytes, so grep treats them as binary
and returns nothing from them. Nineteen occurrences were invisible to every repo-wide
sweep, including baseline counts quoted during this work. Recorded in
`ai-docs/architecture/debugging.md`.
