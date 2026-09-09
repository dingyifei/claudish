> Why exit 0 proves nothing under `claude -p`, and the stream-json recovery that fixed it.
>
> Extracted from `CLAUDE.md` (v7.64.0). Indexed in [`README.md`](./README.md).

# The `team` success oracle — why exit 0 proves nothing

`claude -p` in text output mode emits **ONLY the final assistant message**. Any turn the child takes AFTER writing its answer replaces that answer on the captured surface. Isolated proof, no claudish anywhere in the path:

```
$ echo "Say exactly ALPHA_MARKER on its own line. Then run the bash command: echo hi. Then say exactly OMEGA_MARKER on its own line." | claude -p --model haiku
OMEGA_MARKER          <- 13 bytes. ALPHA_MARKER is gone.
```

Under `--output-format stream-json --verbose` BOTH messages are present, and the `result` field equals the last message — i.e. exactly what text mode prints. **The data survives upstream; only the capture path discards it.** The trigger is any post-answer turn, most often a background `Task`/`Agent` completing, whose notification prompts an acknowledgement — and that acknowledgement becomes `response-NN.md`.

Measured on claudish's `team`, deterministic 2/2 on the first attempt:

| model | output tokens generated | bytes captured | exit | reported | `vote` blocks |
|---|---|---|---|---|---|
| `gc@glm-5.2` | 7,743 | 250 B | 0 | succeeded | 0 |
| `kc@k3` | 4,737 | 396 B | 0 | succeeded | 0 |

Both surviving texts referred to "the review and vote above" — a review that is not on disk. The originally reported incident (236 B from `glm-5.2`) is the same shape. **It is not model-specific and not a claudish bug**: a madbench eval reproduced it on `claude-haiku-4-5` through plain Claude Code, no claudish in the path, 3 consecutive runs. It is a property of the print-mode capture surface.

The existing classifier could not see it because the epilogue passes every test it ran: exit code 0, no `[API Error: ...]` marker, non-whitespace output. `DEFAULT_MIN_OUTPUT_BYTES` is 0 (opt-in, off).

**A byte threshold is the wrong instrument, and this is the design point.** An earlier default of 200 produced a 2/2 false-positive rate against real short answers (measured 141 B and 96 B replies, both valid). Length is a guess. A caller that MANDATED an output shape, by contrast, knows what a complete answer looks like — so `require_pattern` is a precise oracle where length is not.

Detection, then:

- `FailureReason` gains `shape_mismatch`; `classifyRunOutput` gains optional `requirePattern` and `fullOutput`.
- `runModels` gains `requirePattern` and validates the regex **BEFORE reading the manifest and before spawning anything** — a bad regex discovered later would either waste the whole run or, worse, silently enforce nothing.
- The MCP `team` tool exposes `require_pattern` and `min_output_bytes`. The reporter of the original bug had no way to opt in, which is why the option existing internally was not enough.

Two ordering decisions worth keeping:

1. **The shape check runs LAST**, after the api_error / background-ceiling / empty checks. A run that hit one of those would fail the shape check too, and reporting "no `vote` block" for what is really an API error sends the caller after the wrong problem.
2. **The pattern is matched against the FULL response, not `stdoutTail`**, because that tail is capped at `STDOUT_TAIL_LIMIT` (4000 B) — a contract whose marker sits near the START of a long answer would otherwise silently never match. Mutation-tested: changing `fullOutput ?? stdoutTail` to `stdoutTail` fails the suite.

## Recovery — the answer is no longer lost (v7.50.0+)

Detection turned a silent wrong verdict into a loud failure, but the generated answer was still gone: the caller re-ran and paid again. Children now spawn with `--output-format stream-json` and `team-stream-capture.ts` concatenates **every** assistant text block, so a post-answer turn costs nothing.

Deterministic A/B, one real captured stream replayed through `runModels` twice:

| capture | `response-NN.md` | bytes | verdict |
|---|---|---|---|
| `print` (pre-7.50) | `OMEGA_MARKER` | 13 | EMPTY · `shape_mismatch` |
| `stream-json` (default) | `ALPHA_MARKER` + `OMEGA_MARKER` | 27 | COMPLETED |

**Concatenate-everything was chosen over "keep the last substantial message"** because "substantial" is a byte threshold, and `DEFAULT_MIN_OUTPUT_BYTES` is 0 precisely because a 200-byte default recorded two correct short answers (141 B, 96 B) as EMPTY. Intermediate "let me read that file" chatter now lands in the response file; that cost is visible and bounded, whereas a wrong "substantial" verdict discards the answer again silently. `response-NN.md` stays prose either way, so the judge phase and every downstream reader are unaffected.

Four things that are load-bearing:

- **Argv order.** Children get `--verbose --quiet --output-format stream-json`, and `--verbose` MUST precede `--quiet`. claudish consumes `--verbose` as its own verbosity flag *and* forwards a copy to `claude`, which hard-errors on `--print --output-format stream-json` without it (`cli.ts` ~line 645). Reversed, every child narrates itself onto stderr. Verified live end-to-end: real claudish + `gc@glm-5.2` produced stream-json on stdout with exactly one stderr line.
- **`byteCount` and `stdoutTail` are fed the RECOVERED prose, not the raw JSON.** Every consumer — the empty check, `minOutputBytes`, the `[API Error:` match, the reported `outputSize` — is asking about the answer, and raw JSON inflates all of them (an empty answer wrapped in events is still kilobytes). `classifyRunOutput` never learns the wire format changed.
- **Unrecognised JSON is passed through, not dropped.** Only a line that is valid JSON *and* carries a `type` in {system, assistant, user, result} is treated as an event. The rule is per-line and never latches: sniffing the format once from the first line would let a single unexpected banner silently disable recovery for a whole run and quietly restore the original bug. Worst case is raw JSON in a response file — ugly, and visibly so.
- **Passthrough is byte-EXACT; only recovered messages get a synthesised trailing newline.** Not cosmetic: `team-timeout-repro.test.ts` pins a child that writes exactly 65536 bytes with no trailing newline to `outputSize === 65536`, and an added newline made it 65537. Two separators exist for the same reason — a blank line belongs *between messages*, while raw lines are a byte stream that already carries its own newline, and using the message separator for them inserted a blank line between every pair of prose lines.
- **The `is_error` result event is kept.** A terminal `result` normally just repeats the final assistant message, but on a failed turn it carries the error prose print mode would have put on stdout — which is what `API_ERROR_RE` matches. Dropping it would have silently disabled `api_error` detection.

`shape_mismatch` now means something different and says so: under recovery every assistant message was captured, so a missing marker means the model never produced the shape. The old "your answer was discarded" explanation survives only for `captureMode: "print"`. Escape hatch: `CLAUDISH_TEAM_CAPTURE=print` or `TeamRunOptions.captureMode`, kept for diagnosing a capture problem by comparing the two.

Fixture: `test-fixtures/stream-json/haiku-post-answer-turn.jsonl`, a real capture whose `.result` is `OMEGA_MARKER` alone while the stream carries both messages. That one file is the whole bug and the whole fix.

Unrelated but adjacent: `teamCommand` is exported from `team-cli.ts` and imported nowhere, so `claudish team run` is dead code that silently falls through to catalog search. The `team` surface is **MCP-only**.
