/**
 * Read what `logger.log()` actually wrote, through the real logger.
 *
 * `log()` is a no-op unless a log path is configured, so a `[Recovery]` line is
 * invisible to a plain assertion. The alternative — `mock.module("../logger")` —
 * is forbidden here: Bun's module registry bleeds a module mock into sibling
 * test FILES, which has broken this suite's e2e files before. So the capture
 * goes through the logger's own debug-log path instead of replacing it.
 *
 * `noLogs: true` is deliberate: it suppresses the ALWAYS-ON log, which lives in
 * `~/.claudish/logs`. A test must not write to the user's real home. The debug
 * log lands in `<cwd>/logs`, which is gitignored, and is deleted on stop.
 *
 * ─── WHY THERE IS A MARKER, WHICH LOOKS LIKE OVER-ENGINEERING AND IS NOT ───
 *
 * `logger.log()` is ASYNCHRONOUSLY BUFFERED. It pushes onto a module-level
 * `logBuffer` and a 100 ms interval writes that buffer to whatever
 * `logFilePath` holds **at flush time** — not at push time:
 *
 *     function flushLogBuffer() {
 *       if (!logFilePath || logBuffer.length === 0) return;   // ← early return
 *       appendFile(logFilePath, logBuffer.join(""), …);       //   KEEPS the buffer
 *     }
 *
 * So lines pushed while capture file A was installed, but not yet flushed when
 * `stopLogCapture()` set `logFilePath` to null, are NOT discarded: they sit in
 * the buffer and are appended to capture file B the moment the next test
 * installs one. A whole test file's trailing log lines can therefore surface
 * inside the NEXT file's capture — which is exactly what happened: the C-17
 * "exactly one episode id" assertion passed alone and saw two ids when
 * `composed-handler-recovery.test.ts` ran before it in the same process.
 *
 * That is a property of the production logger, not a bug this helper
 * introduced, and it is not worth changing the logger for. The fix here is to
 * stamp a unique marker through the SAME buffer at capture start and read only
 * what follows it: the buffer is FIFO, so anything stale was pushed earlier and
 * lands ahead of the marker.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { getLogFilePath, initLogger, log } from "../../logger.js";

let capturePath: string | null = null;
let marker = "";

export function startLogCapture(): void {
  initLogger(true, "debug", true);
  capturePath = getLogFilePath();
  marker = `[CaptureMarker] ${randomUUID()}`;
  // Through `log()`, so it enters the same FIFO buffer the stale lines are in.
  log(marker);
}

/** Everything written since `startLogCapture`. Waits out the 100 ms flush. */
export async function capturedLines(): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 250));
  if (!capturePath || !existsSync(capturePath)) return [];
  const all = readFileSync(capturePath, "utf-8").split("\n").filter(Boolean);
  const at = all.findLastIndex((l) => l.includes(marker));
  return at >= 0 ? all.slice(at + 1) : all;
}

/** Lines carrying `[Recovery]`, with the ISO timestamp prefix left intact. */
export async function capturedRecoveryLines(): Promise<string[]> {
  return (await capturedLines()).filter((l) => l.includes("[Recovery]"));
}

export function stopLogCapture(): void {
  const path = capturePath;
  capturePath = null;
  marker = "";
  initLogger(false, "info", true);
  if (path) {
    try {
      rmSync(path, { force: true });
    } catch {
      // A pending async append can hold it briefly; the directory is gitignored.
    }
  }
}
