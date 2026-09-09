import { describe, expect, test } from "bun:test";

import { decodeChunk, newStdioDecoder } from "./stdio-decode.js";

const MULTIBYTE_CASES = [
  { label: "three-byte CJK", character: "界", splitAt: 1 },
  { label: "four-byte emoji", character: "🧭", splitAt: 2 },
];

function splitUtf8(character: string, splitAt: number): [Buffer, Buffer] {
  const bytes = Buffer.from(character, "utf8");
  return [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
}

describe.each(MULTIBYTE_CASES)("decodeChunk — $label", ({ character, splitAt }) => {
  test("reassembles a codepoint split across Buffer chunks", () => {
    const decoder = newStdioDecoder();
    const [first, second] = splitUtf8(character, splitAt);

    expect(decodeChunk(decoder, first)).toBe("");
    expect(decodeChunk(decoder, second)).toBe(character);
  });

  test("negative control: Buffer.toString permanently inserts replacement characters", () => {
    const [first, second] = splitUtf8(character, splitAt);
    const decodedWithoutState = first.toString("utf8") + second.toString("utf8");

    expect(decodedWithoutState).toContain("\uFFFD");
    expect(decodedWithoutState).not.toBe(character);
  });
});

test("decodeChunk passes string chunks through unchanged", () => {
  expect(decodeChunk(newStdioDecoder(), "emitted test string 🧭")).toBe("emitted test string 🧭");
});

test("separate decoders keep interleaved partial sequences independent", () => {
  const cjkDecoder = newStdioDecoder();
  const emojiDecoder = newStdioDecoder();
  const [cjkFirst, cjkSecond] = splitUtf8("界", 1);
  const [emojiFirst, emojiSecond] = splitUtf8("🧭", 2);

  expect(decodeChunk(cjkDecoder, cjkFirst)).toBe("");
  expect(decodeChunk(emojiDecoder, emojiFirst)).toBe("");
  expect(decodeChunk(emojiDecoder, emojiSecond)).toBe("🧭");
  expect(decodeChunk(cjkDecoder, cjkSecond)).toBe("界");
});
