/**
 * Unsigned thinking blocks, and why the native path has to drop them.
 *
 * A `thinking` block carries a cryptographic `signature` that Anthropic issued
 * and later verifies. Send one back with a signature Anthropic did not produce
 * and the whole request dies:
 *
 *   400 messages.19.content.0: Invalid signature in thinking block
 *
 * Claudish manufactures exactly that situation. Reasoning from foreign models is
 * surfaced to the client as Anthropic-shaped `{ type: "thinking" }` blocks so
 * Claude Code can render it — but `openai-sse` has no signature to give them
 * (grep it: the word never appears), so the client stores `signature: ""`.
 *
 * While a session stays on a foreign provider that is harmless. Thinking is
 * never echoed back with its signature intact: the OpenAI path folds the text
 * into `reasoning_content` and discards everything else (openai-messages.ts:151).
 * The blocks only become poison when a LATER turn in the same session routes to
 * a real Anthropic model, because `NativeHandler` forwards the conversation
 * verbatim — which is the entire point of a native passthrough.
 *
 * So the strip belongs here, on the way out to api.anthropic.com, and nowhere
 * else. One mixed-provider session is enough to wedge every subsequent native
 * turn until the user compacts.
 *
 * ─── Why absent-signature is the WHOLE problem, not part of it ─────────────
 *
 * The obvious worry is that this only catches an EMPTY signature, while an
 * Anthropic-compatible provider could send a real-looking one that Anthropic
 * still will not accept. MiniMax does exactly that — a 64-hex digest, visible
 * as `7caa0d3cc2a449ac…` in `minimax-m25-turn1-thinking-text-tool.sse`.
 *
 * It never reaches the client. On the Anthropic wire, thinking is stripped at
 * EMIT: `shouldFilterThinking()` is true for every dialect there
 * (base-api-format.ts — it keys on the wire, deliberately, not on a model
 * list), and `createAnthropicPassthroughStream` drops the blocks and
 * re-indexes what remains. Replaying that MiniMax fixture through the real
 * composition yields 0 thinking blocks and 0 signature frames. Same answer for
 * kimi-k2.5, glm-5.2 and deepseek-v4 — all `filterThinking: true`.
 *
 * So a foreign signature is never stored in the conversation and can never come
 * back here. The only thinking blocks that survive to the client carry NO
 * signature, because `openai-sse` has none to give and does not filter. Absent
 * is not a subset of the problem; on the paths that can reach this function it
 * IS the problem.
 *
 * The consequence worth remembering: if `shouldFilterThinking()` is ever
 * narrowed — scoped to a model list, say — foreign signatures start reaching
 * the client and this filter silently stops being sufficient. The two are
 * coupled through the wire, not through anything either file says.
 */

/**
 * True when this block is a thinking block Anthropic cannot have signed.
 *
 * Only an ABSENT or EMPTY signature counts. A non-empty signature is left alone
 * even though it may be a foreign one — see the known gap above; guessing which
 * non-empty signatures are genuine is how you delete real thinking.
 */
function isUnsignedThinking(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const b = block as { type?: unknown; signature?: unknown };
  if (b.type !== "thinking") return false;
  return typeof b.signature !== "string" || b.signature.length === 0;
}

/**
 * Remove unsigned thinking blocks from a message array, IN PLACE.
 *
 * In place because the caller is about to serialize this exact payload, and a
 * copy would have to be threaded back through every branch that touches
 * `payload.messages` — more surface for the strip to be silently skipped on.
 *
 * Returns how many blocks were removed, so the caller can log the fact rather
 * than the transformation being invisible.
 *
 * A message whose content becomes EMPTY is left with an empty array rather than
 * deleted. Removing the message would renumber the conversation, and Anthropic
 * rejects an empty `content` array — but it also rejects the message ordering
 * breaking, and the empty case only arises for a turn that was pure unsigned
 * thinking, which cannot have carried anything Anthropic needs.
 */
export function stripUnsignedThinkingBlocks(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let removed = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const kept = content.filter((block) => !isUnsignedThinking(block));
    if (kept.length !== content.length) {
      removed += content.length - kept.length;
      (message as { content: unknown }).content = kept;
    }
  }
  return removed;
}
