> One service, two consoles, three isolated key+host silos — and the two measurement traps.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# Qwen / Alibaba: ONE service, TWO consoles, THREE isolated silos

The single most confusing provider in claudish, so state it plainly:

**Alibaba Model Studio and QwenCloud are the same service.** Two consoles run in
parallel (`modelstudio.console.alibabacloud.com` and `home.qwencloud.com`), neither doc
set mentions the other, and there is no migration notice — which is exactly why it reads
as two products. A QwenCloud account *is* an Alibaba Cloud International account; closing
one kills the other. There is **no `*.qwencloud.com` API host** (`api.qwencloud.com`
serves a placeholder page); every published endpoint is on `aliyuncs.com`.

**qwen.ai OAuth is a genuinely separate, DEAD product** — the `chat.qwen.ai` device flow
(`~/.qwen/oauth_creds.json`) had its free tier discontinued 2026-04-15 with no paid
replacement, and Qwen Code CLI now points at the Alibaba plans. Nothing to support.

What actually splits three ways is the **plan silo**. Alibaba's own words: keys and base
URLs are "completely isolated and must be used in matching pairs" — **every silo rejects
every other silo's key**, with near-identical 401s.

| Silo | Anthropic host (+ `/v1/messages`) | Provider |
|---|---|---|
| Token Plan (subscription) | `token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` | `qc@` → `qwen-cloud` |
| Coding Plan | `coding-intl.dashscope.aliyuncs.com/apps/anthropic` | **not built** |
| Pay-as-you-go (metered) | `dashscope-intl.aliyuncs.com/apps/anthropic` | `qp@` → `qwen-payg` |

`qwen-payg` is deliberately **absent from `SUBSCRIPTION_PROVIDERS`** (it is metered, so it
must show real per-token pricing, never `SUB`) and carries **no `nativeModelPatterns`**
(`qwen-cloud` owns the dotted `/^qwen3\.\d/i` namespace; patterns are first-wins on array
order). Bare-name reachability comes from the `qwen3.*` chain, where it sits AFTER the
subscription — subscription-first, so a user holding both keys is never silently billed
per token for a model their plan covers. `DASHSCOPE_API_KEY` may alias `QWEN_API_KEY`
(both are metered, i.e. one billing mode in two spellings); **neither may ever alias onto
the plan key**, which is the same reasoning as the sakana-subscription precedent.

**Two measurement traps, both of which cost real time:**

- **`coding-intl…/v1/models` is PUBLIC** — it returns the full roster with a bogus key
  and with no auth header at all. A 200 there proves *nothing* about a credential. Always
  re-test a list endpoint with a deliberately bogus key before believing it. By contrast
  `token-plan…/compatible-mode/v1/models` IS authenticated, provable because a fake path
  under the same prefix 404s while the real path 401s.
- **`provider-definitions.ts`'s "a plan key authenticates ONLY against token-plan" was
  generalised from probing ONE Token Plan key.** True for that key; the actual rule is
  symmetric across all three silos.

**Dotted vs hyphenated is a PRODUCT LINE, not a vendor.** `/^qwen3\.\d/i` used to justify
itself by claiming dotted = Model Studio and hyphenated = OpenRouter/HuggingFace. Measured
2026-08-10, false: Token Plan serves only dotted ids (`qwen3.8-max`, `qwen3.7-max`,
`qwen3.7-plus`, `qwen3.6-flash`) while the Coding Plan serves both — `qwen3-coder-plus`,
`qwen3-coder-next`, `qwen3-max-2026-01-23` next to `qwen3.5-plus`/`qwen3.6-plus`. The coder
line and dated snapshots are hyphenated *Alibaba* names.

The pattern is nonetheless CORRECT for `qwen-cloud`, since Token Plan is dotted-only, and a
bare `qwen3-coder-plus` correctly reaches OpenRouter — no silo claudish implements serves
it. **Do not point hyphenated names at `qwen-payg` on the strength of the id shape**:
routing filters by CREDENTIAL, not by model, so an unserved id earns a `400 Model not exist`
and STOPS (400 is non-retryable), the same dead-end documented for `glm-*`. Unlike the
Coding Plan's public list, the PAYG roster is authenticated (401 without a key), so that
change needs a real `DASHSCOPE_API_KEY` to verify against — or routing that consults live
`modelDiscovery` rather than guessing from the name.
