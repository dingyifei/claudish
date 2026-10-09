# Black-box behaviour suite — integration results

> **Ported 2026-09-19** from branch `worktree-qwen-token-plan` (`6b627f1`) onto `eceab30`.
> These are that branch's results. Provider names, shortcuts and variables are
> translated to HEAD's everywhere, including inside quoted test titles and output, and
> the retired term for a per-credential model list is now *dynamic models catalog*, so
> quoted material is not byte-verbatim. The suite for the metered-fallback billing gate,
> which HEAD does not carry, is removed with every row and finding about it; the counts
> below exclude it.
>
> **At HEAD only two pieces exist:** `test-helpers/blackbox-env.ts` and
> `handlers/shared/model-unsupported.blackbox.test.ts` (E1–E4, whose two `Model not exist`
> cases failed on `eceab30` and pass once that wording is recognised). The discovery,
> availability, probe-discovery and credential-type suites need APIs HEAD lacks: an
> exported parser returning `{models, dropped, total}`, `discoverDynamicCatalog`,
> `_setDynamicCatalogForTest`, `splitByChatCapability`, and `readinessDetail`.

The 125 tests already in this branch were written by the agents that wrote the
code, in the same pass. They are implementation-coupled regression tests. This
suite is the only independent behaviour check in the change: `gpt-6-astra` wrote
it inside a sandbox containing the spec, the acceptance criteria, the measured
facts, and `.d.ts` contracts with every function body stripped — and no
implementation file at all. Blindness was enforced by the FILE SYSTEM, not by an
instruction (`qa/inputs.json`), and the writer's own `Files Read` list contains
no path outside the sandbox, so nothing here is marked SUSPECT.

Its value comes entirely from the writer not having seen the code. Therefore:
**no assertion was edited to make a test pass.** Where a test failed and was
right, the finding is below with the failure output pasted. Where a test targeted
API that no longer exists, it was moved aside and recorded as obsolete, never
rewritten into something green.

**Result: 64 kept and passing, 1 quarantined as a real defect, 29 dropped as
obsolete-by-design-change, 0 dropped as wrong.** Suite on that branch:
**3657 pass / 19 skip / 0 fail** across 237 files (baseline 3557/19/0 across 231).

---

## 1. Where the tests live

Colocated with the module each covers, `foo.ts` → `foo.blackbox.test.ts`. Most of
the names collide with an existing implementation-coupled test file; the
`.blackbox.` infix is the provenance marker and is the convention to reuse for
any future blind suite. Nothing was overwritten.

| Black-box file | Covers | Tests |
|---|---|---|
| `packages/cli/src/providers/model-discovery.blackbox.test.ts` | `providers/model-discovery.ts` | 20 |
| `packages/cli/src/providers/model-availability.blackbox.test.ts` | `providers/model-availability.ts` | 6 |
| `packages/cli/src/providers/transport/probe-discovery.blackbox.test.ts` | `providers/transport/probe-discovery.ts` | 28 |
| `packages/cli/src/handlers/shared/model-unsupported.blackbox.test.ts` | `handlers/shared/model-unsupported.ts` | 8 |
| `packages/cli/src/auth/credentials/types.blackbox.test.ts` | `auth/credentials/types.ts` | 2 |
| `packages/cli/src/test-helpers/blackbox-env.ts` | shared isolation helper | — |

`test-env.ts` became `test-helpers/blackbox-env.ts`, next to the repo's existing
`test-helpers/credential-gate.ts` and `test-helpers/provider-quota.ts`. It
duplicates neither. Its rewrite is the one substantial adaptation and is
explained in §4.

---

## 2. Outcome by test

`PASS` = the implementation satisfies an independently written expectation.

### `model-discovery.blackbox.test.ts` — 20 kept, 1 quarantined, 4 obsolete

| ID | Outcome | What it proves / why dropped |
|---|---|---|
| D1 × `owned_by` / `ownedBy` | PASS | Both measured wire spellings parse; a new id survives; no capability or context window is invented. |
| D2 × missing / null / object container, null body | PASS | `total: null`, no rows. "No parseable container" is not a valid empty enumeration. |
| D3 | PASS | A real `data: []` is `{models:[],dropped:0,total:0}` — distinguishable from D2. |
| D4 × null / scalar / missing-id / numeric-id / empty-id row | PASS | A lost row is COUNTED. A truncated parse is never labelled complete. |
| D5 | PASS | An all-invalid enumeration reports three drops, not a genuine empty plan. |
| D6 | PASS | A three-model generated catalog parses; no vendor minimum or whitelist. |
| D7 × `context_length` / `context_window` / `max_context_length` | PASS | The account's own window survives each documented spelling; nothing is hardcoded. |
| D10 × Token Plan host, PAYG host | PASS | The diagnostic names the exact rejecting hostname, not a generic "check your key". |
| D11 | PASS | A provider with no `modelDiscovery` is `not-declared` with no `failure` — absent, not a transport failure. |
| **D12** | **FAIL — test right → QUARANTINED** | See the D12 finding in §3. |
| D8 × stale / incomplete | OBSOLETE | Parameterised only over statuses deleted in `fe8722e` (decision D-K). |
| D9 × stale / incomplete | OBSOLETE | Same. The "deliberate sizing exception" has no weak state left to draw on. |

### `model-availability.blackbox.test.ts` — 6 kept, 4 obsolete

| ID | Outcome | What it proves / why dropped |
|---|---|---|
| A1 × fresh | PASS | A generated wire id in a fresh account catalog is `serves`. Not satisfiable by any shipped model list. |
| A2 × fresh | PASS | A missing id is `not-served` ONLY when complete fresh evidence exists. |
| A3 × failed | PASS | A failed refresh neither confirms nor denies — `unknown`. This is the money-asymmetry: weak evidence may not drop a paid subscription. |
| A3 × not-declared | PASS | An undeclared discovery is equally non-committal. |
| A4 | PASS | Membership follows the WIRE id, never the row's display label. |
| A5 | PASS | A smaller complete fresh catalog legitimately removes one id while retaining another — no fixed count, no union-forever, no cached eligibility. |
| A1/A2 × stale, A1/A2 × incomplete | OBSOLETE | Both statuses deleted in `fe8722e`. |

### `probe-discovery.blackbox.test.ts` — 28 kept

| ID | Outcome | What it proves |
|---|---|---|
| K1 × 9 measured ids | PASS | Image, audio and the documented cross-edition video ids classify `not-chat` and are excluded. |
| K2 × 9 general forms | PASS | Video is a NAMING rule, not a whitelist of the three measured ids: boundaries, case and other vendors all match (`qa_i2v_next`, `qa.r2v.next`, `T2V-01`, `veo-3`, `sora-2`). |
| K3 | PASS | A wildcard deployment route is not a concrete model to offer. |
| K4 | PASS | A generated catalog-unknown id is `unknown` and STILL OFFERED — not rounded to `chat`, not hidden. |
| K5 × qwen-vl, gemini-vision, qa-t2vector, qa-sorafenib, qa-veolia | PASS | Video patterns do not swallow vision INPUT models or unanchored substrings. The negative control on the regex set. |
| K6 | PASS | The split keeps unknown rows, duplicate occurrences, attached row data and within-group order, and does not mutate its input. |
| K7 | PASS | Probe RANKING uses the same filter as the classifier — the selection path was not left on an obsolete permissive one. |
| K8 | PASS | An all-non-chat catalog yields no candidate rather than falling back to the first image row. |

### `model-unsupported.blackbox.test.ts` — 8 kept

| ID | Outcome | What it proves |
|---|---|---|
| E1 × raw / enveloped `Model not exist`, Zen Go wording | PASS | Alibaba's measured wording is recognised regardless of HTTP status or response envelope. |
| E2 × InvalidApiKey / invalid access token or token expired / Incorrect API key provided | PASS | A credential rejection is NOT classified as model exclusion. The false-positive direction (sending a user with a broken key to audit their model name) is closed. |
| E3 | PASS | A vendor opt-in URL is detected as actionable and is not confused with model absence. |
| E4 | PASS | A plain key error does not pretend to carry an action link. |

### `types.blackbox.test.ts` — 2 kept

| ID | Outcome | What it proves |
|---|---|---|
| T1 | PASS | A vault exception keeps the sentence the user can act on — not erased, not `[object Object]`. |
| T2 | PASS | A 40 000-line SDK dump becomes ONE bounded line that still contains the headline. |

### The on-disk store suite — 17 declarations (S1–S17, 21 expanded) — ALL OBSOLETE

It targets the seven exported symbols of the store module that persisted the dynamic
models catalog: its identity fingerprint, salt, write, lookup, read, clear and
maximum-age constant. Every one was deleted with that module (396 lines) in
`fe8722e`, decision **D-K: stop persisting the dynamic models catalog**. There is no
store, so there is no cache key, no salted fingerprint, no thirty-day retention
window and no expiry state. S1–S17 are not failing tests; they address a module
that does not exist, and rewriting them into something that passes would have
produced 21 green assertions about nothing. The file was preserved on that branch;
it is not carried here.

Worth recording rather than merely deleting: the removal of the store is what
makes S1's whole class of defect (one credential identity inheriting another
seat's entitlement) *impossible* rather than *tested*, and it is the same change
that removed the variable that switched the store off — a variable the blind
writer still set, from the contract it was given.

---

## 3. Defects found by tests whose author had never seen the code

### The D12 finding — the blank-`*_BASE_URL` guard is dead code for every provider with a static `baseUrl` (NOT fixed, quarantined)

Caught by D12. Failure, verbatim:

```
src/providers/model-discovery.blackbox.test.ts:
119 |   test("D12 a blank Token Plan endpoint is a failure, not an absent subscription list", async () => {
120 |     process.env.QWEN_TOKEN_PLAN_BASE_URL = "";
121 |     const result = await discoverDynamicCatalog(provider);
122 |     expect(result.status).toBe("failed");
123 |     expect(result.models).toEqual([]);
124 |     expect(result.failure?.kind).toBe("unreachable");
                                       ^
error: expect(received).toBe(expected)

Expected: "unreachable"
Received: "no-credentials"

      at <anonymous> (.../packages/cli/src/providers/model-discovery.blackbox.test.ts:124:34)
(fail) discovery failures identify the rejecting silo > D12 a blank Token Plan endpoint is a failure, not an absent subscription list [0.73ms]

 20 pass
 1 fail
```

The writer took this from the design document it was handed
(`contract/behaviour-spec.md`, architecture.md §4.2), which lists it as the FIRST
of "the two collapse sites, fixed":

> `model-discovery.ts:423` — `if (!baseUrl) return [];` becomes
> `return recordFailure({ kind: "unreachable", … detail: "no base URL resolved — check " + … })`.
> **A blank `QWEN_TOKEN_PLAN_BASE_URL` override currently reads as "this plan lists no models".**

That premise is wrong about `resolveBaseUrl`, which skips empty values
(`if (v) return v`) and falls through to the provider's static `baseUrl`. The
guard was written and is correct; the case it names cannot reach it. Confirmed
directly — a blank override silently reverts to the vendor default host, while a
non-blank one is honoured:

```
{"override":"","status":"failed","failure":{"kind":"no-credentials","provider":"qwen-token-plan",
 "endpoint":"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models"}}
{"override":"https://qa-override.invalid","status":"failed","failure":{"kind":"no-credentials",
 "provider":"qwen-token-plan","endpoint":"https://qa-override.invalid/compatible-mode/v1/models"}}
```

(`no-credentials` rather than a 401 only because the QA environment holds no
Token Plan key. On a machine that HAS one, a blank override sends a real,
credentialed request to the DEFAULT host — the user's override is discarded with
no diagnostic at all, which is the more interesting half.)

What R6/R8 actually demand is satisfied: the status is `failed`, not an empty
plan, so a misconfiguration is never reported as "your subscription lists no
models". What is NOT satisfied is the diagnostic — it names neither the setting
nor the misconfiguration, and the architecture document's claim #1 is not true of
the shipped code.

**Not fixed**, because the fix is not obviously correct: distinguishing
"declared but empty" from "unset" in `resolveBaseUrl` changes what an empty
`*_BASE_URL` means for EVERY provider and every base-URL env var, and `FOO=` is
a common shell idiom for "leave it at the default". That is a decision for the
contract owners, not a repair to smuggle in under a QA phase.

Quarantined, not skipped and not deleted — the blind writer's own rule was "no
`test.todo()` entries to make a report look green", and a skipped test in the
suite is the same thing. The test, its failure and the root cause:
`quarantine/` beside this file. The removal is marked in place, in
`model-discovery.blackbox.test.ts`, with the reason.

---

## 4. Counts, and every adaptation with its reason

Counted in EXPANDED cases — each parameterised row is one test, which is how the
runner counts and how the plan enumerates its inputs.

| | Count |
|---|---|
| Delivered by the blind writer | **94** across 6 files |
| **Kept and passing** | **64** across 5 files |
| **FAIL, test right → quarantined** | **1** — D12 |
| **OBSOLETE by design change** | **29** |
| **FAIL, test wrong → dropped or repaired** | **0** |

Obsolete arithmetic: the store suite S1–S17 = 21 expanded cases (S1 expands ×5)
+ `D8`/`D9` × {stale, incomplete} = 4 + `A1`/`A2` × {stale, incomplete} = 4.
All 29 trace to one commit, `fe8722e` / decision **D-K**. 64 + 1 + 29 = 94.

### Adaptations, and which tests are still independent evidence

**Every kept test's assertions are byte-identical to what the blind writer
produced.** Nothing in the list below changes an expected value, so all 64 keep
their standing as independent evidence.

1. **Import rewiring (all 5 files).** `../contract/*` stems are declaration files
   with no runtime. Repointed at the real modules; `await import()` became a
   static import where nothing depended on load ordering any more.

2. **Renamed symbols (2 files).** Three symbols named with the retired term became
   `DynamicCatalogStatus`, `discoverDynamicCatalog` and
   `_setDynamicCatalogForTest`. The seed seam
   also LOST its per-seat argument (`(provider, seat, models, opts)` →
   `(provider, models, opts)`) because the credential fingerprint went with the
   disk store; the calls dropped `"qa-seat"`.

3. **Removed API (2 files).** `discoverDynamicCatalog` takes no `{ cachePath }`
   — there is nothing to persist, so there is no path to redirect. D11 was
   otherwise unchanged.

4. **`test-env.ts` → `test-helpers/blackbox-env.ts` — the one substantial
   rewrite, and it touches no test.** The original relocated `HOME` and replaced
   `globalThis.fetch` at MODULE LOAD and restored them only at
   `process.once("exit")`. Correct in a seven-file sandbox; wrong in a 237-file
   suite, for two independent reasons:
   - Bun's runner shares ONE process across every test file (the same property
     that makes `mock.module()` bleed here, which the conventions file already
     bans). A process-wide `HOME` swap changes what every LATER file sees, and a
     permanently throwing `fetch` would take the live-API `fallback-handler` and
     `routing-rules` tests with it.
   - It would not have worked anyway: `profile-config.ts:18` and
     `all-models-cache.ts` (`:102` at HEAD) snapshot `homedir()` at MODULE scope, so a `HOME`
     swap performed after those modules load is invisible to the very readers it
     was meant to redirect — and `loadConfig()` would have read the developer's
     real config.

   So isolation is now FILE-SCOPED (`useBlackboxEnv()` → `beforeAll` install,
   `afterAll` uninstall), and config reads are isolated through the repo's own
   `setConfigFileOverride()` seam instead of through `HOME`. The writer's
   two guarantees are intact: no real user state, and a fail-closed fetch
   tripwire whose `afterEach` check catches even an implementation that swallows
   the rejection into `unknown`. The tripwire now records the attempted URL
   rather than a fixed string — strictly better diagnostics, same
   `toEqual([])` assertion. The variable that switched the deleted store off was
   dropped: it no longer exists.

   Verified against `test:safe`: the guard reports no damage to either guarded
   real file, and the suite is 0 fail. It duplicates no existing helper
   (`test-helpers/` held only `credential-gate.ts` and `provider-quota.ts`).

5. **Formatting.** `biome` reordered imports and wrapped two array literals. No
   semantic change.

**No test was edited to make it pass.**

---

## 5. The writer's own stated limits — are they still true?

The plan's "What must not be claimed" list and its B-series table of tests blocked on
a missing public seam still hold for everything outside the billing gate: no
refresh-preservation proof, no public-list entitlement test (B10), no product-UI or
live-auth validation (B13/B16), and the Coding Plan request path remains
**UNVERIFIED**, as required.

One design tension the writer flagged is still open and is NOT a test problem:

> `behaviour-spec.md` §4.4.b separately permits a catalog plan-drop to stand
> unless fresh account evidence restores it. That differs from the user's
> stricter catalog rule. No test here silently endorses that catalog-denial
> exception. … the contract owners should reconcile the prose before integration.

`fe8722e` moved that branch's code to the stricter rule ("cloud catalog data may deny
a candidate only when there is no fresh per-account answer at all"). HEAD does the
opposite for plans whose `modelDiscovery` is `"catalog"`: published membership drops
the candidate before discovery runs. See `ai-docs/architecture/routing.md`.

---

## 6. Negative control

The control on that branch mutated an expected value in the billing-gate suite, so it
is not carried here. For the one suite ported to HEAD, the E1 `Model not exist` cases
fail against `eceab30` and pass with the wording recognised.

## 7. Gate

```
bun run typecheck   PASS
bun run lint        PASS (977 pre-existing warnings, 0 errors)
bun run format      PASS
bun run test:safe   PASS — 3657 pass / 19 skip / 0 fail, 237 files; guard reports
                    no change to ~/.claudish/config.json or all-models.json
```
