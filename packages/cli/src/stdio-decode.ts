import { StringDecoder } from "node:string_decoder";

/**
 * Decode one stdio chunk, holding any partial multi-byte sequence for the next.
 *
 * A `data` chunk ends at the pipe's read boundary, which lands mid-codepoint
 * often enough to matter on any non-ASCII answer. `StringDecoder` keeps the
 * dangling bytes; `Buffer.toString` replaces them with U+FFFD — permanently, in
 * the answer a reader ends up with.
 *
 * Strings are passed through because a test can `emit("data", "…")` directly,
 * and `StringDecoder.write` only accepts a Buffer.
 *
 * Lives here rather than in either consumer because both supervise a `claudish`
 * child over a pipe and both need it. The channel had it; `team` did not, and
 * read its children with `chunk.toString()` — so a CJK character or emoji
 * straddling a read boundary was mangled in `response-<id>.md` and counted
 * wrong in `outputSize`.
 */
export function decodeChunk(decoder: StringDecoder, chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : decoder.write(chunk);
}

/** A decoder per pipe. Never share one between stdout and stderr. */
export function newStdioDecoder(): StringDecoder {
  return new StringDecoder("utf8");
}
