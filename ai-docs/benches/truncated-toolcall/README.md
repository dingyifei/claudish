# truncated-toolcall — does the client honour a mid-stream `error` event?

Proves what a unit test cannot: that **Claude Code acts on** the wire signal claudish sends
when an upstream stream dies mid tool-call, rather than executing a tool on truncated JSON.

Result and raw evidence: [`../../reports/truncated-toolcall-live-verification.md`](../../reports/truncated-toolcall-live-verification.md).
Rationale for the fix itself: `ai-docs/architecture/adapters.md` § "A stream that dies mid tool-call".

## Why this exists

v7.12.7 shipped `stop_reason: "max_tokens"` on the assumption that the client would discard
a partial `tool_use` block. It does not — Claude Code 2.1.217 executed one anyway. Any claim
about client behaviour has to be measured against a released binary, never argued from the
protocol. This bench is the apparatus for doing that.

## Layout

| File | What |
|---|---|
| `mock-upstream.ts` | A fake Responses API that kills the socket mid tool-call, then serves a clean turn on retry. Logs every request. |
| `madbench.yaml` | The interactive bench. See "Known blocker". |

## Running it

```bash
# 1. the mock, with its request log
MOCK_LOG=/tmp/mock.log bun ai-docs/benches/truncated-toolcall/mock-upstream.ts

# 2. the binary under test, under its OWN HOME
HOME=/tmp/probe-home \
OPENAI_CODEX_API_KEY=mock-key-not-a-secret \
OPENAI_CODEX_BASE_URL=http://127.0.0.1:8899 \
  <claudish-launcher> -y -q --model cx@gpt-6-astra -p "create a file called notes.txt containing two lines"

# 3. the verdict — read the run's OWN transcript
grep -c "__unparsedToolInput\|InputValidationError" /tmp/probe-home/.claude/projects/*/*.jsonl
```

Non-zero means the client executed a truncated tool call. Run it twice, once against the
build under test and once against the released install
(`~/.bun/install/global/node_modules/claudish/bin/claudish.cjs`), for a before/after pair.

## Four things that will bite you

**A fresh `HOME` is load-bearing, not hygiene.** `OPENAI_CODEX_BASE_URL` redirects only the
API-key arm. With an OAuth credential present, `OpenAICodexTransport.getEndpoint()` returns
`this.cachedAuth.endpoint` and the env var is silently ignored — the probe then measures the
live backend and bills for it. A fresh `HOME` drops `~/.claudish/codex-oauth.json` and forces
the API-key arm.

**`-y -q` are both required.** `-y` clears the first-run auto-approve gate; `-q` returns
before the update check, whose "nobody can answer" test is `process.stdin.isTTY` — and a
machine-driven TTY looks exactly like a human one.

**Never let the mock fail every request.** It punishes correct behaviour: a client that
correctly discards and retries retries into the wall and times out *identically to the bug*,
so the experiment discriminates nothing. Fail the targeted request once, then serve a
complete turn.

**Claude Code fires a session-title request CONCURRENTLY with the real turn**, and hands it
the same prompt text. Truncating "the first request" hits the title generator; the main turn
answers cleanly milliseconds later and the run looks like a pass. The two never overlap in
size (~3.7 KB vs ~88 KB), so `mock-upstream.ts` requires marker **and**
`length >= MOCK_MIN_BYTES` (default 20000) before calling a request the main turn.

The general lesson, and the reason every request is logged with its size and verdict:
**instrument the fake, not just the thing under test.** Both false results above were
invisible in the pass/fail outcome and obvious in the request log.

## Known blocker (interactive)

`madbench.yaml` drives the interactive path and currently ERRORs with
`claudecode: agent never started: agent did not start within 1m0s`. Two of claudish's
first-run gates are cleared by `-y -q`; a third — Claude Code's own theme picker — is one of
the four dialogs madbench seeds into the sandbox `~/.claude.json`, and that seeding has not
been confirmed to survive when the harness binary is claudish rather than `claude`.

The manual `-p` procedure above needs none of that seeding and produced the verified result,
so the interactive bench is kept for when someone wants the TUI path specifically.
