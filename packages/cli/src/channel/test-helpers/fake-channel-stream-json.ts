#!/usr/bin/env bun
/**
 * Captured-frame stream-json stand-in used by session-manager.test.ts.
 *
 * It announces a real status frame at startup, reads newline-delimited user
 * frames for as long as stdin remains open, emits captured assistant prose plus
 * a terminal result for each turn, and exits only after stdin closes.
 */

import {
  CAPTURED_ASSISTANT_PROSE,
  CAPTURED_STATUS_LINE,
  capturedAssistantFrame,
  capturedSuccessResult,
} from "./captured-stream-json.js";

const args = process.argv.slice(2);

function getFlag(name: string): string | null {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? null);
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function writeFrame(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function assertUserFrame(inputLine: string): void {
  const input = JSON.parse(inputLine) as {
    type?: unknown;
    message?: { role?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
  };
  if (
    input.type !== "user" ||
    input.message?.role !== "user" ||
    input.message.content?.[0]?.type !== "text" ||
    typeof input.message.content[0].text !== "string"
  ) {
    throw new Error(`invalid user frame: ${inputLine}`);
  }
}

function emitTurn(turns: number, printArgv: boolean, messageCount: number): void {
  const prose = printArgv ? JSON.stringify(args) : CAPTURED_ASSISTANT_PROSE;
  const count = printArgv ? 1 : Math.max(1, messageCount);
  for (let index = 0; index < count; index++) {
    writeFrame(capturedAssistantFrame(prose));
  }
  writeFrame(capturedSuccessResult(prose, turns));
}

async function main(): Promise<void> {
  process.stdout.write(`${CAPTURED_STATUS_LINE}\n`);

  if (hasFlag("--trap-term-exit-zero")) {
    process.on("SIGTERM", () => process.exit(0));
  }

  if (hasFlag("--fail")) process.exit(1);

  const sleepValue = getFlag("--sleep");
  if (sleepValue !== null) {
    await new Promise((resolve) => setTimeout(resolve, Number.parseFloat(sleepValue) * 1000));
    process.exit(0);
  }

  const messageCount = Number.parseInt(getFlag("--messages") ?? "1", 10);
  const printArgv = hasFlag("--print-argv");
  let pending = "";
  let turns = 0;

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    let newlineAt = pending.indexOf("\n");
    while (newlineAt !== -1) {
      const inputLine = pending.slice(0, newlineAt);
      pending = pending.slice(newlineAt + 1);
      newlineAt = pending.indexOf("\n");
      if (!inputLine.trim()) continue;

      assertUserFrame(inputLine);
      emitTurn(++turns, printArgv, messageCount);
      // Stdin deliberately remains open after the result in interactive mode.
    }
  });

  process.stdin.on("end", () => {
    setTimeout(() => process.exit(0), 20);
  });
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
