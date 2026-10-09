# Alibaba billing-product black-box test plan

> **Ported 2026-09-19** from branch `worktree-qwen-token-plan` (`6b627f1`) onto `eceab30`.
> This is the blind writer's plan as delivered on that branch. Provider names are
> HEAD's, and the retired term for a per-credential model list is now *dynamic models
> catalog*. The billing-gate cases (the `metered-fallback` suite, and the blocked
> B-series rows that needed it) are removed, because HEAD does not carry the gate.
> Results, and which suites exist at HEAD: [`blackbox-results.md`](blackbox-results.md).

## Status and boundaries

**STOP_AT: implement. Tests authored, not executed, compiled, or typechecked. No pass claim.**

Only the supplied specification, acceptance criteria, measured facts and public contracts were read. No implementation was located or inspected. Test files import the declaration-module stems under `../contract/`; those modules deliberately have no runtime implementations in this sandbox. Integration must supply the corresponding public implementations or relocate the tests beside the production modules and change import paths only. Do not fill the sandbox with mock implementations to make this suite green.

The writer's seven `.test.ts` files covered its seven supplied declaration contracts. Six are listed below; the billing gate's is not. `test-env.ts` is isolation infrastructure, not an implementation or test double of the product.

### Isolation and input provenance

- Bun + TypeScript; `bun:test`; no snapshots and no `mock.module()`.
- Before dynamically importing any product module, relocate HOME, USERPROFILE and XDG_CONFIG_HOME to a generated directory **inside `tests/`**, and disable Keychain, 1Password and the default on-disk persistence of the dynamic models catalog. Keep the relocation process-wide until exit so a later file cannot reopen the real HOME through a cached module.
- Store functions always receive explicit scratch paths. Capability classification receives an explicit nonexistent catalog path; compatibility functions without a path see the relocated, cold HOME.
- A fail-closed fetch tripwire rejects and records unexpected fetches. The after-test check catches even an implementation that swallows the rejection into `unknown`. It returns no simulated vendor responses. It is a safety backstop, not a transport injection seam or a claim to intercept every possible network library.
- Tests restore per-test environment changes and reset the supplied seams. Scratch files are removed; HOME and the process-wide fetch tripwire are restored at process exit. Do not run these files concurrently with unrelated suites that intentionally exercise network access.
- Account membership in the dynamic models catalog is generated per test. There is no expected 25-model or 10-model list, no edition inference from counts, and no guessed production context window. Parser sizing values are test inputs, not product defaults.
- The parser's field shapes and credential-error strings come from `measured-facts.md` and the declaration comments. Malformed rows, generated IDs and context-window spellings are deliberate contract inputs/mutations, **not claimed live recordings**. Named image/audio/video IDs test capability, never account membership. No invented Alibaba quota-exhaustion wording.

### Oracle priorities and design tensions

1. The user's current rule is authoritative: stale, incomplete, failed and catalog evidence must not deny eligibility. The availability tests enforce that asymmetry directly.
2. `behaviour-spec.md` §4.4.b separately permits a catalog plan-drop to stand unless fresh account evidence restores it. That differs from the user's stricter catalog rule. No test here silently endorses that catalog-denial exception. The blocked routing test B8 below records the requested observable behavior; the contract owners should reconcile the prose before integration.
3. `measured-facts.md` says an unrecognized ID defaults to “chat,” while the later tri-state contract clarifies **unknown, still offered**. K4/K5 require that clarified distinction, not confirmed chat and not hidden.
4. The capability pseudocode in the design mentions catalog fields absent from the supplied slim-cache contract. Do not invent a catalog fixture schema to test it. Warm-catalog cases are blocked pending a public schema/seam (B12).

## Implemented cases

The IDs below are also present in test titles. Each parameterized row expands into separately named tests; the inputs are enumerated here. “Wrong implementation” is the mutation/defect that must make that case red. None of these are assertions about internal call counts or private maps.

### `model-availability.test.ts`

| IDs / expanded inputs | Observable behavior | Requirement / acceptance | Wrong implementation caught |
|---|---|---|---|
| A1 × fresh/stale/incomplete | A generated wire ID in the account's dynamic models catalog is served | R2, R3, R8 | Uses a pinned model list; discards positive retained/partial evidence |
| A2 × fresh | A missing wire ID is not served when complete fresh evidence exists | R2, R3 | Never applies a genuine account exclusion |
| A2 × stale/incomplete | A missing wire ID is unknown, never not-served | R8 | Uses weak evidence to drop the subscription |
| A3 × failed/not-declared | Neither unanswered state proves inclusion or exclusion | R8, R9 | Treats an empty result as an authoritative empty plan |
| A4 | Membership follows wire ID, not the row's human display label | R2 | Compares the requested wire ID against presentation labels |
| A5 | A smaller complete fresh dynamic models catalog can legitimately remove an ID while retaining another | R2, R3, R8 | Enforces a fixed count, unions old membership forever, or caches old eligibility across a new seeded result |

A3 intentionally has the same eligibility result for two distinct producer states. It does **not** prove the producer preserves that distinction; D11/D12 cover a real absent-vs-failed producer branch, and B7 covers the missing transport branches.

### `model-discovery.test.ts`

| IDs / expanded inputs | Observable behavior | Requirement / acceptance | Wrong implementation caught |
|---|---|---|---|
| D1 × `owned_by`/`ownedBy` | Both measured wire spellings preserve a new ID and complete counts; no tools/window is invented | R2, R9, R11, V1 parser shape only | Requires one owner spelling, rejects new IDs, or fabricates capability/context metadata |
| D2 × missing/null/object container, null body | Missing enumeration gives `total:null`, no usable rows | R8 completeness | Equates “no parseable container” with a valid empty enumeration |
| D3 | Real empty array gives total 0, dropped 0, no rows | R8 completeness | Loses the distinction between malformed container and empty enumeration |
| D4 × null/scalar/missing-ID/numeric-ID/empty-ID row | Preserve valid row, count all received rows and each dropped row | R8 completeness | Silently discards malformed entries and labels a truncated parse complete |
| D5 | All-invalid enumeration reports three drops, not a genuine empty list | R8 | Folds all parse loss into an empty success |
| D6 | A small generated list parses regardless of published model counts | R2, R3 | Enforces a vendor/edition minimum or whitelist |
| D7 × context_length/context_window/max_context_length | Supplied account-specific window survives each documented spelling | R2, R12 | Hardcodes a window or recognizes only one spelling |
| D8 × stale/incomplete | Legacy wrapper returns the useful retained list | R8 | Returns [] for every non-fresh status |
| D9 × stale/incomplete | Context sizing uses retained evidence for the matching ID, not an unrelated ID | R8; deliberate sizing exception | Rejects all stale sizing, or substitutes the first listed model's window for any request |
| D10 × Token Plan/PAYG rejecting endpoint | Diagnostic identifies the exact rejecting silo and credential problem | R6, V1 diagnostic only | Prints generic “check your key” without saying which isolated host rejected it |
| D11 | Provider with no discovery declaration returns not-declared, empty models, no failure | R8 five-state contract | Calls absent discovery a transport failure |
| D12 | Blank Token Plan base-URL override returns failed/unreachable and identifies the setting | R6, R8, R12 | Collapses a misconfigured endpoint to not-declared/empty plan, ignores the override, or attempts a real request |

D1–D7 test parsing, not the complete refresh state machine. D8/D9 test consumers of injected states, not production of stale/incomplete states. Seeding the answer and asserting that same answer would not prove refresh behavior, so that purported test is deliberately not included.

### The on-disk store suite (a module deleted in `fe8722e`)

| IDs / expanded inputs | Observable behavior | Requirement / acceptance | Wrong implementation caught |
|---|---|---|---|
| S1 × changed key/base URL/source/provider/salt | Original accepted entry is readable; changed identity cannot inherit it; original remains intact | R2, R3, R8 identity binding; V4 URL override | Fingerprints only provider, omits any named identity dimension, or falls back to a by-provider lookup |
| S2 | Header name case/order changes preserve access to the same entry | R8 identity stability | Fingerprints object serialization or case-sensitive header names |
| S3 | Header **values** stay case-sensitive | R3 identity binding | Lowercases credentials and merges distinct seats |
| S4 | A different provider cannot read an entry by presenting its fingerprint | R3 identity binding | Ignores the lookup's provider scope |
| S5 | Two seat entries coexist and retain their different lists | R3 | Stores only one list per provider |
| S6 | ENOENT yields miss and creates no file | R8; no read-side user-state writes | Treats absence as failure or writes during lookup |
| S7 | Unknown fingerprint in a valid file yields miss | R3, R8 | Returns the first/only provider list on identity miss |
| S8 | Truncated JSON yields unreadable with diagnostic, and nullable projection returns null | R8 failed ≠ absent | Catches corruption and calls it miss, throws, or confirms corrupted data |
| S9 | Reading a directory (non-ENOENT error) yields unreadable, not miss | R8 | Collapses every filesystem exception to stable absence |
| S10 | Invalid entry model-array shape cannot confirm eligibility | R8 | Trusts any valid JSON object as a usable accepted list |
| S11 | Expired entry returns expired with original timestamp; legacy read gives null | R8 | Confirms expired membership, calls it a plain miss, or loses diagnostic age |
| S12 | Recent accepted state round-trips through explicit path even with default persistence disabled | R8; hermetic path contract | Disables explicit scratch writes as well as the real default path, or drops entry metadata |
| S13 | Maximum age is the specified thirty days | R8 architecture contract | Retains entitlement indefinitely or silently changes the retention window |
| S14 | Salt/identity computation is non-persisting and stable before first write | R8 store contract | Writes on every routing read or changes identity salt on every lookup |
| S15 | File contains a salted 16-hex fingerprint, accepted metadata, stable salt, no raw credential values | R3 identity/security contract | Persists raw keys/tokens or fails to retain the salt needed to retrieve accepted evidence |
| S16 | Reading retained evidence preserves original date and file bytes | R8 | Refreshes the timestamp on read so old entitlement never expires |
| S17 | Explicit clearing removes evidence and rotates the salt | R3, R8 | Leaves entries or reproduces the old fingerprint after a clear |

These test the store's public semantics. They do not establish that the discovery caller writes **only** fresh results, nor that writes are atomic under concurrent processes (B7/B17).

### `probe-discovery.test.ts`

| IDs / expanded inputs | Observable behavior | Requirement / acceptance | Wrong implementation caught |
|---|---|---|---|
| K1 × qwen-image-2.0, qwen-image-2.0-pro, wan2.7-image, wan2.7-image-pro | Image generators classify not-chat and are excluded | R11, V2 | Treats subscription membership or lack of catalog data as chat capability |
| K1 × qwen-audio-3.0-tts-plus, qwen-audio-3.0-realtime-plus | Audio models classify not-chat and are excluded | R11, V2 | Drops image models only and still offers speech as chat |
| K1 × happyhorse-1.1-t2v/i2v/r2v | Documented cross-edition video models are excluded | R11, measured negative control | Leaves the exact measured video gap unchanged |
| K2 × video-01, wan2.2-video, hunyuan-video, T2V-01, qa_i2v_next, qa.r2v.next, qa-v2v, veo-3, sora-2 | General video forms work across boundaries/case/vendors | R11 design rule | Whitelists the three measured IDs or misses boundary/case/vendor variants |
| K3 | A wildcard route is not a concrete model to offer | R11 contract | Offers deployment wildcard syntax as a chat model |
| K4 | Generated cold-catalog ID is unknown and still offered | R11, R2 | Rounds unknown to confirmed chat or hides it as not-chat |
| K5 × qwen-vl, gemini-vision, qa-t2vector, qa-sorafenib, qa-veolia | Vision inputs and unanchored substrings remain unknown/offered with cold catalog | R11 | Excludes vision input models or overmatches video substrings |
| K6 | Split retains unknown rows, duplicate occurrences, attached data and within-group order without mutating input | R11 presentation contract | Drops unknowns, mixes them with confirmed chat, deduplicates, or loses row metadata |
| K7 | Probe ranking keeps a new unknown candidate and excludes image/audio/video candidates | R11, V2 consumer | Fixes classifier but leaves the selection path using an obsolete permissive filter |
| K8 | All-non-chat input yields no probe candidate | R11 | Falls back to the first image/video row when filtering empties the list |

No warm-catalog “chat” fixture is invented; B12 covers the missing input contract. No claim about rendered `?` labels or footer counts follows from K6; B13 covers those surfaces.

### `types.test.ts`

| ID | Observable behavior | Requirement / acceptance | Wrong implementation caught |
|---|---|---|---|
| T1 | Credential exception retains its actionable message | R6 | Erases the failure reason or replaces it with `[object Object]` |
| T2 | Large multiline exception becomes one shorter bounded diagnostic line | R6 | Dumps multiline SDK output into the routing explanation without bounding it |

The supplied types describe three-valued readiness, but an interface is not an executable authority. T1/T2 are diagnostic tests only; neither proves `failed` survives readiness resolution.

### `model-unsupported.test.ts`

| IDs / expanded inputs | Observable behavior | Requirement / acceptance | Wrong implementation caught |
|---|---|---|---|
| E1 × raw/enveloped `Model not exist`, measured Zen Go unsupported wording | Unsupported wording is recognized independently of HTTP status | R6 | Omits Alibaba's wording or only recognizes one response envelope |
| E2 × InvalidApiKey, invalid access token or token expired, Incorrect API key provided | Credential rejections are not classified as model exclusion | R6, V1 | Treats every auth-shaped error as a missing model |
| E3 | Vendor region opt-in link is actionable, not model absence | R6 | Requires one hardcoded error type or confuses account opt-in with a nonexistent model |
| E4 | Plain key error does not claim an actionable URL | R6 | Treats every explanatory error message as an action link |

These predicates do not prove retry behavior, status remapping, or preservation of the provider's complete error in the UI (B6/B13).

## Required tests BLOCKED by missing public input/control contracts

These are planned requirements, **not implemented, skipped tests, or claimed coverage**. No `test.todo()` entries are used to make a report look green. Each has an observable oracle and a specific wrong implementation; the missing ingredient is a callable, hermetic public surface. Adding a test-only copy of the routing logic or a dummy `CredentialProvider` and testing that dummy would not test this feature.

| ID | Planned behavior / oracle | Requirement | Wrong implementation caught | Needed contract/seam |
|---|---|---|---|---|
| B2 | Only DASHSCOPE_API_KEY, subscription genuinely absent → qwen-payg primary `qpay@qwen3.7-plus`; repeat when catalog really plan-drops an unheld subscription | R12 | Treats every catalog subscription candidate as a held/displaced plan | Route signature, routing-entry/catalog schema, authority registration/reset seam; ambient keys isolated |
| B4 | Authority outcomes: present→available true, absent→false, failed/throw→false **with failed diagnostic retained**; unknown provider genuinely absent | R6 | Boolean authority erases source failures before routing decisions | Executable authority and registration/reset seams; types alone are insufficient |
| B7 | Fresh complete fetch accepts state; malformed JSON/transport failure retains identity-matched stale state; missing container, continuation markers (`has_more`, `next`, `next_page`, `next_page_token`), dropped rows and empty 200 yield incomplete and leave accepted bytes unchanged; valid smaller complete refresh replaces them | R2, R8 | Marks every nonempty parse fresh, overwrites state with partial data, ignores pagination, or compares counts to old/published counts | Discovery transport + credential-authority injection; the exposed seed bypasses the producer and store |
| B8 | Fresh account inclusion beats catalog omission; catalog/stale/incomplete/failed evidence alone must not deny a candidate (user's governing rule) | R2, R4, R8 | A catalog plan-drop silently removes a paid subscription before the live account can answer | Catalog-entry schema + route invocation; reconcile §4.4.b with user's stricter rule |
| B9 | Seed accepted identity A; rotate key, resolved endpoint or source to B; force discovery outage → failed/empty, never A's stale list; same-identity outage → stale; unresolved identity → failed, no provider-wide fallback | R3, R8 | Disk store is correct but in-memory discovery cache is provider-keyed, or no-identity branch fetches any stored list | Credential and transport injection for real discovery path |
| B10 | Public Coding Plan model list cannot confirm entitlement; existing Token Plan subscribers do not depend on purchase stock | R9, R10, V1 | Adds unauthenticated entitlement source or gates existing coverage on purchase availability | Provider/discovery entry points and controllable source responses; no stock input exists in these contracts |
| B11 | Token Plan and PAYG keep old key names, aliases, resolved hosts and overrides; same-prefix keys are never product evidence; inspect actual outgoing signer's credential | R1, R5, R12, V1, V4 | Aliases subscription key onto PAYG, ignores override, classifies `sk-sp-` as product, or labels metered signing SUB | Provider definition/credential resolution/transport contracts |
| B12 | Public warm catalog positive tools/thinking/vision evidence yields chat; positive flags cannot override an already-known image/audio/video exclusion | R11 | Never confirms chat, ignores catalog refresh, or widens known non-chat into chat | Slim catalog JSON schema or `_setCatalogEntriesForTest` declaration; neither supplied |
| B13 | Picker/preflight/probe show product+billing, stale/incomplete age and uncertainty despite nonempty rows; unknown capability gets marker, not false chat label; error messages distinguish key/quota/model/uncertain access | R1, R5, R6, R8, R11; V2, V5 | Correct helper results lost by display consumers, or failure read occurs only on empty list | Public render/probe/preflight contracts and catalog seams; V5 screenshots outside sandbox scope |
| B15 | Billing classification follows active signing arm on a dual-mode provider at each advance | R5 | Memoizes provider-name billing, or treats any auth object as OAuth | Credential-decided billing probe registration/reset contract |
| B16 | Live authentic/bogus silo controls, built-provider signing and billing log, real TUI screenshot, repo-build session | V1–V6 | Unit seams all pass while production setup diverges | Authorized live environment, repo build and real credentials; explicitly prohibited here |
| B17 | Simultaneous readers/writers see whole old or whole new valid store, never a torn successful entry | R8 atomic persistence contract | Writes directly over the file rather than atomically replacing it | Isolated runtime module supplied to child processes; no implementation in sandbox |
| B18 | Repeated stale/incomplete discovery within TTL reuses evidence without repeated timeout; expiry permits new evidence | R8 availability contract | Repeated request-path outages multiply discovery delays | Transport/credential seam and controllable clock/TTL contract |

### What must not be claimed

- No refresh-preservation or in-memory identity-cache proof follows from store-only or seeded availability tests.
- No public-list entitlement, configuration back-compat, product UI, live auth, or billing-label validation is complete.
- Coding Plan request path remains **UNVERIFIED**, as required.
- R10 has no injectable stock input here. An assertion that a handcrafted object lacks a stock field, or a grep for one, would not be an observable black-box test and is deliberately omitted.
- Future mutation validation should make each listed wrong implementation red. No mutation run was performed at this stop point.

## Files Read

All paths are relative to the supplied sandbox. Directory listings were used only to locate the supplied contracts and empty output directory. The following are the files opened for input, less two contracts for work not carried to HEAD (the deleted store module and the billing gate); no implementation or outside file was opened:

1. `TEST-CONVENTIONS.md`
2. `spec.md`
3. `acceptance-criteria.md`
4. `measured-facts.md`
5. `contract/model-availability.d.ts`
6. `contract/model-discovery.d.ts`
7. `contract/model-unsupported.d.ts`
8. `contract/probe-discovery.d.ts`
9. `contract/types.d.ts`
10. `contract/behaviour-spec.md`
11. `contract/architecture-contracts.md`
