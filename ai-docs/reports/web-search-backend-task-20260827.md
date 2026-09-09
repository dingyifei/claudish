# Linear issue body — server-side web search with pluggable backends

Paste the section below into Linear. Everything above the rule is a note to us,
not part of the issue.

Suggested metadata:

| Field | Value |
|---|---|
| Title | Implement server-side web search with pluggable backends |
| Labels | `feature`, `adapters`, `provider-parity` |
| Estimate | L — new subsystem, config surface, and per-provider wiring |

This work is also a candidate for `ROADMAP.md` under parked work, with the
trigger condition "a foreign model loses a turn to `web_search` in a real run",
which has now happened at least once.

---

## Implement server-side web search with pluggable backends

### Problem

`WebSearch` under Claude Code is a **server-side** tool: Anthropic executes it
inside their API and returns results to the model. A foreign provider has no
such arrangement with the harness, so when a foreign model calls it, nothing
executes it.

claudish currently recognises the call and does nothing with it. The whole
implementation is a stub:

```ts
// packages/cli/src/handlers/shared/web-search-detector.ts
/**
 * Web search tool call detector.
 * v1: Logs a warning when web_search is detected.
 * v2 (future): Will intercept and execute the search.
 */
const WEB_SEARCH_NAMES = new Set(["web_search", "brave_web_search", "tavily_search"]);
```

It warns and passes the call through unchanged:

> `[claudish] Warning: Model requested web search ('web_search') but server-side web search is not yet implemented. The tool call will pass through to the client as-is.`

### Evidence this costs real work

In team session `team-20260827-0015`, `gk@grok-4.6` spent a turn calling
`web_search` for `"macos security add-generic-password -X hex password flag"`.
The call did nothing. Recorded in `stats/02.json` of that session.

Web research is a routine part of the tasks these models are given, so every
foreign model is currently doing this work with `Bash` and `curl`, or not at
all.

### Proposed design

A single `SearchBackend` interface, one implementation per vendor, selected by
user configuration. One implementation then serves every provider, rather than
wiring search separately per provider.

```
model calls web_search
        │
        ▼
 web-search-detector  ──recognises──▶  SearchBackend.search(query, opts)
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ▼                     ▼                     ▼
                      Exa                   Brave                Tavily
                        └─────────────────────┼─────────────────────┘
                                              ▼
                                  normalised results  ──▶  tool_result to the model
```

**Backends to ship:** Exa, Brave, Tavily. The set must be open, so a user can
add another without a claudish change to the core.

**Credentials.** Each backend needs an API key. It must resolve through the
existing credential layer so 1Password references and the macOS Keychain work
the same way they do for provider keys. Do not add a second credential path.

**Config surface.** The user picks the backend and supplies the key. Follow the
shape already documented in `ai-docs/architecture/custom-endpoints.md` and
`predefined-endpoints.md`.

**Result normalisation.** Each vendor returns a different shape. The model must
receive one consistent `tool_result` regardless of backend, or prompts become
backend-specific.

### Two traps this must not fall into

**1. The two-table silent fallback.** claudish's existing registry pattern
requires an entry in BOTH `BUILTIN_PROVIDERS` and `PROVIDER_PROFILES`; a missing
profile routes to OpenRouter with no error. If the search backends mirror that
shape, they inherit the same failure mode: a half-registered backend silently
does the wrong thing. Prefer a single-table design where a missing entry is a
startup error, not a silent redirect.

**2. The config allowlist.** Any new `ClaudishProfileConfig` field must be added
to `loadConfig`'s allowlist in `profile-config.ts`. A field omitted there
survives on disk until the first global save and is then dropped, with no error.

### Interim mitigation (separate, smaller, ship first)

Until this lands, stop advertising the tool. Strip `web_search` from the
outbound request for foreign models so they never call it and never lose a turn.
The model then falls back to `Bash` with `curl`, or asks the user. This is a
same-day change and is independent of the backend work.

### Acceptance criteria

- [ ] A foreign model calling `web_search` receives real results.
- [ ] Exa, Brave and Tavily backends all work, selected by user config.
- [ ] Adding a fourth backend needs no change to the detector or the handlers.
- [ ] Keys resolve through the existing credential layer, including 1Password
      and Keychain.
- [ ] A missing or misconfigured backend fails loudly at startup, never silently.
- [ ] The result shape handed to the model is identical across backends.
- [ ] Search queries and results are redacted from logs on the same terms as
      other request content.

### Related

- `ai-docs/reports/grok-tool-name-mangling-20260827.md` — the same grok run also
  recorded a malformed tool name on the `openai-sse` wire. Separate defect, but
  found in the same artifacts and also touches tool-call parsing.
