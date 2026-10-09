# Plan: the claudish catalog v3 reader

**Owner:** the claudish session `v3-subscription:blocks-everyone`
**Inputs:** the backend handoff (models-index `docs/reviews/2026-09-19-claudish-v3-reader-handoff.md`) and its verification, `VERIFY_models_index_v3_handoff-20260919.md`
**Decisions:** recorded in the verification report. No billing gate. claudish's static values match the backend contract exactly, with no aliases: the Alibaba providers are `qwen-coding`, `qwen-token-plan` and `qwen-payg`, as models-index `ai-docs/alibaba-provider-changes.md` names them.

## Design: translate once, at the edge

claudish reads v2 catalog vocabulary in many places. `aggregators[]` and its `provider` field alone are read in 17 files, across routing, pricing, the picker and the TUI probe. Rewriting every consumer would put billing-critical routing at risk in the same release.

The reader instead converts v3 into the internal shape those files already read, at one boundary. This works because every v3 route binding names exactly one claudish provider: `openai/codex-subscription` is `openai-codex`, and `qwen/qwencloud-token-plan` is `qwen-token-plan`. After translation, an aggregator row's `provider` **is** the claudish provider name, and its external id is the published `externalModelId`. The handoff asks for the same thing: "Keep SDK provider names and prefixes in the client transport adapter."

What v3 can express and the internal shape could not must still survive the translation:

- `routeStatus: "unknown"` rows are **not routable**. They carry no callable id, so they are dropped from connections. Availability stays three-valued, and an unknown route never becomes "not served".
- Membership coverage travels with each plan. Only complete, unexpired coverage licenses a "not served" answer. The field is `rosterCoverage` today; the backend is asked to rename it `membershipCoverage`, with every other "roster" name (see request 2 in the verification report), and the reader reads whichever name is published when it ships.
- Plan membership comes from `subscriptionPlanIds`, counted by distinct model.

## The binding table

All 30 registered profiles, and the claudish provider each one means:

| Route profile | claudish provider | Note |
|---|---|---|
| `anthropic/claude-code-subscription` | `native-anthropic` | |
| `anthropic/direct-api` | — | Not mapped. The native route forwards Claude Code's own model ids and credentials, so it never needs a catalog wire id. Unchanged from today. |
| `cognition/devin-subscription` | `devin` | |
| `deepseek/direct-api` | `deepseek` | |
| `fireworks/gateway` | `fireworks` | **new provider** |
| `google/antigravity-subscription` | `antigravity` | |
| `google/direct-api` | `google` | |
| `minimax/coding-plan-subscription` | `minimax-coding` | |
| `minimax/direct-api` | `minimax` | |
| `mistralai/direct-api` | `mistralai` | |
| `moonshotai/direct-api` | `kimi` | |
| `moonshotai/kimi-code-subscription` | `kimi-coding` | |
| `ollama/cloud` | `ollamacloud` | |
| `openai/codex-subscription` | `openai-codex` | |
| `openai/direct-api` | `openai` | |
| `opencode/go-subscription` | `opencode-zen-go` | |
| `opencode/zen` | `opencode-zen` | |
| `openrouter/gateway` | `openrouter` | |
| `poe/gateway` | `poe` | needs its factory |
| `qwen/dashscope-direct` | `qwen-payg` | |
| `qwen/modelstudio-coding-plan` | `qwen-coding` | **new provider** |
| `qwen/qwencloud-token-plan` | `qwen-token-plan` | **renamed** from `qwen-cloud` |
| `sakana/direct-api` | `sakana` | |
| `sakana/fugu-subscription` | `sakana-subscription` | |
| `together-ai/gateway` | `together` | **new provider** |
| `vertex/google-cloud` | `vertex` | |
| `x-ai/direct-api` | `x-ai` | |
| `x-ai/supergrok-subscription` | `grok-subscription` | |
| `z-ai/direct-api` | `z-ai`, `glm` | Both use `https://api.z.ai`; they differ only in the key name (`ZAI_API_KEY`, `ZHIPU_API_KEY`). |
| `z-ai/glm-coding-subscription` | `glm-coding` | |

The local providers (`ollama`, `lmstudio`, `vllm`, `mlx`, `litellm`) have no catalog profile and are unaffected.

## Reconciling the work on `worktree-qwen-token-plan`

That session stopped on 2026-09-19 and holds 9 commits plus 72 uncommitted files (+1,175 / −3,228). The uncommitted files are unsigned, because 1Password refused there too. Its export is preserved in this worktree's session folder (`qwen-branch-handoff/uncommitted-vs-1e5e157.patch`, SHA-256 `c6967f95…`). The session's own map of what is safe to carry drives this table.

**Commits**

| Commit | Carry | Why |
|---|---|---|
| `c0ac7d8` failed vs absent credentials | yes | The readiness notices below depend on it. |
| `56066fc` gate subscription → metered | **no** | The billing gate. Jack decided against it. |
| `24d6074` gate bypasses | **split** | Drop the gate parts. Keep three fixes: `op-source.ts`, where `hasOpSources()` sniffed globally, so a locked 1Password marked a never-configured provider "failed" instead of absent; the readiness test that built the real `AntigravityCredentialProvider` and spawned a bare `security` against the login keychain (1 spawn before the fix, 0 after); and one `describeReadiness` per candidate in `routing-rules.ts`. |
| `fe8722e` stop persisting the dynamic catalog | yes, edited | Remove 1 gate line in `routing-rules.test.ts`. |
| `83f9afb` roster → dynamic models catalog | yes | It is independent of the gate. |
| `6b627f1` black-box tests | yes, edited | Drop `metered-fallback.ts` and `metered-fallback.blackbox.test.ts`. |
| `80ff29b`, `1e5e157` docs | yes, edited | Remove the gate passages (53 and 2 lines). |
| `0ba1bfa` three products | yes, edited | Remove `meteredFallbackDefault: "block"` from `qwen-coding` and the test that it blocks. |

**Uncommitted groups**

| Group | Carry | Why |
|---|---|---|
| A. rename to `qwen-token-plan`/`qtoken`/`qpay`, delete the aliases | **yes** | It is the backend contract exactly: one spelling, no aliases, no shims. Check each value against the contract table while carrying it. |
| B. gate removal | only the log fix | The gate is never carried. Keep the fix for `routing-rules.ts` printing `[claudish] [claudish]`, a bug already on `main`. |
| C. video capability | yes | The handoff requires it: `videoOutput` excludes chat, `videoInput` alone never does, and the name-shaped rule applies only where the catalog has no row. Runtime-verified there on 6 cases. |
| D. public discovery is not entitlement | yes | The handoff requires it. `qwen-coding` lists its models without authentication, so its list proves coverage, not account access. Availability denies only on `"account"` evidence. |
| E. partial v3 join | no, rebuilt | It is unverified after a late edit, and this plan translates at the edge instead. Its `subscriptionPlanIds` handling is a reference. |
| F. tests and fixtures | with their groups | |

**The backend contract is the source of static values.** models-index `ai-docs/alibaba-provider-changes.md` fixes the provider names, prefixes, credentials and hosts, and says: "Product identities have one spelling and no aliases, migration shims, alternate credential names, or retired-name diagnostics." Jack confirmed it on 2026-09-19. Where claudish differs, claudish changes.

## Slices

Each slice ends green and committed. Codex writes the tests from real captured responses; each slice is also checked against the live generation.

**1. Reader and edge translation. This alone restores the catalog.**
- `SUPPORTED_CONTRACT_VERSION` becomes 3. The v3 `Accept` header is sent on `queryModels`, `queryPlans` and `probeModels`.
- Walk `queryModels?status=all&includeRouteVariants=true` by `nextCursor`. Pages are capped at 200, so the full catalog is 7 pages.
- Pin `queryPlans` and `probeModels` to page 1's `generationId`. A 410 mid-walk restarts the walk once; a 503 or 426 keeps the current cache and the 9.7 guard.
- Translate through the binding table. The cache file records `contractVersion: 3` and the `generationId`, and a v2 cache on disk is refused, which forces one refresh after updating.
- Remove `FIREBASE_SLUG_TO_PROVIDER_NAME` from its 3 files; the binding table replaces it.
- Bring the 9.7 guard in line with the contract. `alibaba-provider-changes.md` line 21: "Unavailable catalog data means coverage is unknown … Claudish discards incompatible catalog payloads, reports that state visibly, and continues using its existing configured routing and discovery behavior." Today `routeBare` throws on an unreadable catalog, so a bare model name stops routing. It must report the state and continue with configured routing, with coverage unknown.
- Acceptance: 1,301 models and 19 plans read live. Alibaba memberships are 10/20/31 after translation. `minimax@minimax-m3` sends `MiniMax-M3`. A before/after table of bare-name routes shows no removed route.

**2. Probes.** Read both maps, keyed by binding. A `client_model_selection_required` or `no_verified_probe_model` entry goes to endpoint discovery, and the client never invents a model id.

**3. Providers.**
- `qwen-coding`, rebased from `worktree-qwen-token-plan` without its two billing-gate commits.
- The Alibaba identities match the contract with nothing left behind: `qwen-cloud` becomes `qwen-token-plan`; the prefixes are `qcode`, `qtoken` and `qpay`; the credentials are `QWEN_CODING_PLAN_API_KEY`, `QWEN_TOKEN_PLAN_API_KEY` and `DASHSCOPE_API_KEY`. `qc`, `qp`, `dashscope`, `QWEN_CLOUD_PLAN_API_KEY` and `QWEN_API_KEY` are removed, and so are comments describing them.
- `together` and `fireworks` gateway providers, each in both `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES`.
- Poe's provider factory.

**4. Membership coverage.** Expired or unknown coverage means "unknown", never "not served".

**5. Dev validation and release.** On the live generation, exercise everything the handoff's release acceptance lists:

- the 12 subscription bindings and 5 gateway profiles, with a real request wherever a credential exists;
- Alibaba memberships 10/20/31;
- the six wire translations;
- pinned pagination and both probe maps;
- unknown account access reaching client discovery;
- an authenticated Poe request and a project-aware Vertex request.

Then release as 9.8.0 and tell the backend.

## Routing redesign: decided (Jack, 2026-09-20)

The order stands and must be implemented: **user rules → subscriptions (catalog membership) → dynamic subscriptions (the account's own model list) → native API → gateways → fallback.** Then drop every hop without a credential, and send exact wire ids.

**Inside a tier (Q1).** No local preference list and no local state. The model's own vendor first (for `kimi-k3` that is Kimi Coding, because Moonshot makes it), then cheapest by the catalog's per-connection `pricing`, then everything else. A spent limit is not remembered: the request simply moves to the next hop.

*Available:* `pricing` is published per connection as `{input, output, cachedRead}` (560 of 894 models in `g-20260919013346169-feffb8ad` carry one). Where a connection has no price, it sorts after the priced ones.

**Metered and subscription are always separate providers (Q2),** even when one key serves both, so that spending money is explicit and each lands in its own tier. OpenCode already is: `opencode/zen` (metered) and `opencode/go-subscription`.

**Ollama Cloud is the exception, settled 2026-09-20.** models-index keeps one `ollama/cloud` route: Ollama spends included credits first and then purchased credits on the same account, and the API exposes no request-level choice, so a second provider would imply a billing boundary Ollama cannot enforce. Jack's decision: the single route is **metered**, because money can be spent once the included credits are gone, and a customer who wants it earlier rewrites the route in their own rules. claudish already classifies `ollamacloud` as metered, so no code changed.

**The fallback (Q3)** stays, and it is exactly the answer to "the providers that serve this model are absent or failing". It is optional, and configurable to any aggregator. It is appended only when that aggregator serves the model. When nothing serves the model, no service is enabled for it, or the aggregator does not list it, claudish returns an error rather than a hop that cannot work. So the dead `qwen3.8-max` → OpenRouter hop becomes either a working Fireworks hop or an error.

**No catalog (Q4).** Sharp rule: no guessing and no local state. claudish never converts a model id it was not given. Without the cloud catalog it cannot reach the cloud at all, so offline it serves local providers only. A subscription whose wire id differs (Kimi Coding's `k3`) is simply not offered until the catalog is readable.

**A dynamic subscription's list (Q5).** Fetch it with a short timeout and retries; it is cached afterwards. On a timeout, keep the hop only when the name is in that provider's namespace.

**What this deletes:** `default-routing-rules.ts`, `buildCatalogRoutingRules`, `retainKnownCatalogRoutingRules` and the four-way `mergeRoutingRules`. Only the user's own rules remain as a dictionary, and they are used verbatim.

**The gate:** a before-and-after route table over every model in the catalog, read by hand. Every difference must be a deliberate addition or a removal this decision names; no route may disappear silently.

## Test All with every key set (2026-09-19, dev 9.8.0 at `fa0ac40`)

30 providers tested: 16 ready, 3 local servers not running (LM Studio, vLLM, MLX), Vertex not set up, 10 failed. Each failure below was re-probed alone through the probe path to get the full error.

**claudish fixes (planned, not started)**

1. **Gemini direct API: probe effort "minimal".** Probe pick `gemini-3.8-flash` answers `400 "Thinking level MINIMAL is not supported for this model"`. Same class as the Antigravity fix (`4128e07`): the probe's effort must not be a value the model rejects. Decide per provider (`EFFORT_OMITTED` or "low" for `google`), and check whether the Gemini adapter itself must map "minimal" to the lowest level a Gemini 3 model accepts.
2. **Wrong hint for that error.** The 400 above is labelled "Model not supported by this provider. Verify model name." The model is fine; only the thinking level is rejected. The model-unsupported wording (`fa09cb7`) matches "not supported for this model". Narrow the match so a parameter rejection is not read as an unknown model.
3. **Mistral: probe pick is a Labs model.** Pick `labs-leanstral-1-5` answers `403 "… is a Labs model. To use Labs models, an admin must enable them in your organization settings"`. The backend's probe pick is wrong for accounts without Labs: report it to models-index; in claudish, a 403 of this kind must move Test All to the next candidate instead of stopping.
4. **Poe: no probe pick.** The catalog lists Poe as `no_verified_probe_model`, and Poe has no model list in claudish, so Test All says "transport does not support discovery". Add Poe's model list (`/v1/models`, to verify) and `discoverProbeModel`, the same way as Antigravity.
5. **Devin: model list timed out during Test All.** "no probe model: The operation timed out" while 30 providers ran in parallel. Alone, the same call returned 209 models. Check the discovery timeout under load.
6. **403 hint wording.** Alibaba PAYG's 403 "Model access denied." is shown with the 401 text "a 401 can also mean the right key on the wrong plan's host". Give a 403 its own hint.

**Account side (Jack), measured**

- **Alibaba Coding Plan:** the key stored as `QWEN_CODING_PLAN_API_KEY` is the Token Plan key (both show `sk-••Cxg`); coding-intl answers `401 invalid access token`. Store the Coding Plan's own key.
- **Alibaba PAYG:** the key is accepted by `dashscope-intl` but every model answers `"Model access denied."` (qwen3.7-plus, qwen3.8-max, qwen3.8-flash, qwen3.8-omni-flash); the China host rejects the key (403). Re-checked against the account's OWN list: `GET /compatible-mode/v1/models` returns 200 with 169 models, the catalog's `qwen/dashscope-direct` wire ids appear in it with the same spelling, and a chat request for an id taken from that list (`qwen-plus-character`) is also `403 Model.AccessDenied`. So the catalog data is not the cause on this evidence; the account's model permissions are (Model Studio activation or workspace access). Open until Jack confirms the account works in Alibaba's own console.
- **Alibaba Coding Plan:** skipped by Jack's decision (not available on this account).
- **MiniMax metered, CORRECTED: claudish bug.** The old key failed on both hosts. Jack reset it, and the fresh key (`sk-••0EQ`) answers 200 on `api.minimax.io` for `GET /v1/models`, `/anthropic/v1/messages` and `/v1/chat/completions`, and `401 invalid api key (2049)` on `api.minimaxi.com` for all three. claudish fixes metered MiniMax to the China host (`b7173d2`, 2026-08-11), which was right for a China key and is wrong for an international one. The catalog publishes one profile, `minimax/direct-api`, with no region, so the host is claudish's choice. **Fixed** by Jack's choice (b): the default is the international host, a China-platform key sets `MINIMAX_BASE_URL=https://api.minimaxi.com`, and metered MiniMax now declares `modelDiscovery` (`/v1/models`). Jack's `~/.claudish/config.json` also pinned `endpoints.MINIMAX_BASE_URL` to the China host, which overrides both the default and the environment; it was removed with his approval (backup `config.json.bak-before-minimax-endpoint-20260919`). After that, the proxy probe for `minimax@MiniMax-M3` is `live`, and bare `minimax-m3` routes `mmc@MiniMax-M3 > zengo@minimax-m3 > mm@MiniMax-M3 > minimax/minimax-m3`.

**Local servers, measured**

- Port 8000 is **oMLX** (`omlx-server`, an MLX server), not vLLM. It is bound to `127.0.0.1:8000` and answers `401` without an API key. claudish maps port 8000 to vLLM (`VLLM_API_KEY`) and expects MLX on port 8080, so the vLLM row reaches oMLX and fails, and the MLX row finds nothing. Needs a decision: point the MLX provider at oMLX (`MLX_BASE_URL`, `MLX_API_KEY`), or teach claudish to recognise oMLX.
- LM Studio answers on port 1234 (200).
- **Quota, not errors:** MiniMax Coding `429` plan limit; GLM on bigmodel.cn `429` insufficient balance (the same key is `ready` on Z.AI); Sakana Fugu API `429` prepaid credit.

## Vertex on ADC: what it would take (evaluated 2026-09-20, nothing built)

**Already there, measured on this machine.** `auth/vertex-auth.ts` supports ADC and a service
account; the ADC file is an `authorized_user` with `quota_project_id: xlabs-ai-tools`; `gcloud auth
application-default print-access-token` works; and with `VERTEX_PROJECT` set, the credential
authority mints a 254-character Bearer for `vertex`. The transport, the endpoint builder and the
per-publisher adapters (Gemini, Anthropic, OpenAI-shaped) all exist.

**The blocker is not auth.** `resolveRemoteProvider("vertex@…")` returns null, so no handler is ever
built and the proxy answers "its provider has no credential", which is the wrong reason. The remote
registry drops every provider whose effective base URL is empty
(`providers/remote-provider-registry.ts:41-50`), and Vertex's definition carries `baseUrl: ""`
because its transport builds the URL from project, location and publisher. Vertex is therefore
unreachable today whatever credential is configured.

**Work items, in order.**

| # | Work | Touches | Size |
|---|---|---|---|
| 1 | Let a provider declare that its transport builds the endpoint, and keep it in the registry. Fix the message so an excluded provider does not read as a missing credential. | `provider-definitions.ts` (one flag), `remote-provider-registry.ts`, `proxy-server.ts` | S |
| 2 | Resolve the project without an env var: ADC `quota_project_id`, else `gcloud config get project`, with `VERTEX_PROJECT` still winning. Same for the location, with a documented default. | `auth/vertex-auth.ts` | S |
| 3 | Report readiness honestly: ready on ADC, "needs a project", or "needs `gcloud auth application-default login`", and show the source in the Providers tab instead of a key column that expects `VERTEX_PROJECT`. | `auth/credentials/*vertex*`, `tui/` | M |
| 4 | Probe pick: models-index marks Vertex client-selected, so claudish lists the publisher models for the project and ranks them newest-first, like every other dynamic provider. | `transport/vertex-oauth.ts`, `model-discovery.ts` | M |
| 5 | Live validation: a Gemini publisher model and an Anthropic publisher model, streaming, plus the 401 refresh path. Tests by Codex, and the settings docs. | tests, `docs/` | M |

**Estimate.** Items 1 and 2 are the difference between "unreachable" and "works with ADC", and are
small and self-contained. Items 3 to 5 are what make it a first-class provider. Whole thing: one
focused session, roughly 8 to 12 hours of agent work with live checks; items 1 and 2 alone are about
2 hours.

**Risks.** Model availability is per project and per location, so a probe pick that works here may
404 elsewhere; the Anthropic publisher path uses `rawPredict` and its own payload shape, so it needs
its own live check; and a service-account setup (rather than a user ADC) is a second credential shape
we would not have exercised.

**Vertex: move from API key to Application Default Credentials**

Vertex AI Express uses an API key today. Move it to ADC, as set up by Jack: `aiplatform.googleapis.com` enabled on project `xlabs-ai-tools`, credentials at `~/.config/gcloud/application_default_credentials.json` with quota project `xlabs-ai-tools`, verified by a `gemini-3.8-flash` request.

- Read the ADC file (`authorized_user` refresh token, or a service account), exchange it for an access token, and refresh before expiry. No key in claudish config.
- Project from the ADC quota project, with an env override; location with an env override and a documented default.
- Endpoint `https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent`.
- Readiness: `present` when the ADC file resolves to a token, `failed` with a detail when it exists but cannot be exchanged, `absent` when there is no file.
- To check first: `providers/transport/vertex-oauth.ts` is already a project-aware transport and may already read ADC; read `ai-docs/architecture/` for any Vertex notes before changing it.
- Validate with a real request and Test All; the catalog binding is `vertex/google-cloud` (gateway).
