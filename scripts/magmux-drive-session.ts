#!/usr/bin/env bun
/**
 * scripts/magmux-drive-session.ts — REFERENCE IMPLEMENTATION, not wired into the CLI.
 *
 * Usage: bun scripts/magmux-drive-session.ts <session-id> "<prompt>"
 * Exits 0 with {"ok":true,"answer":...} on success, 1 otherwise.
 *
 * Drive a real interactive Claude Code session through magmux to completion.
 *
 * Neither magmux flag does this alone: `-w` counts a REPL's prompt as "done"
 * (done = dead OR inputReady) and quits in ~6s reporting SUCCESS having done
 * nothing, while no `-w` waits for a keypress forever. This drives the session
 * over the socket instead.
 *
 * Measured 2026-08-22: 6/6 deterministic runs, 14-24s each; a forced turn
 * deadline returns `turn_timeout` in 16.7s rather than hanging; no orphaned
 * processes or stale sockets after any run. Rationale and the full trap list:
 * ai-docs/architecture/headless-vs-interactive.md.
 *
 * KNOWN IMPROVEMENT: this POLLS `list` every 600ms. The protocol is designed for
 * event SUBSCRIPTION (`snapshot` / `exit` frames), which is what madbench's
 * internal/magmux/socket.go does and is more robust — no poll-interval race.
 * Polling was sufficient to validate the sequence; prefer events for real use.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { type Socket, connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface DriveResult {
  ok: boolean;
  answer: string;
  costSeen: boolean;
  states: string[];
  reason?: string;
}

const QUIET = process.env.DRIVER_QUIET === "1";
const log = (m: string) => {
  if (!QUIET) console.log(`[drv] ${m}`);
};

export async function driveClaude(opts: {
  id: string;
  prompt: string;
  cwd?: string;
  bootMs?: number;
  turnMs?: number;
}): Promise<DriveResult> {
  const sockPath = `/tmp/magmux-${opts.id}.sock`;
  const states: string[] = [];
  let mux: ChildProcess | null = null;
  let sock: Socket | null = null;

  // Inherited from a parent Claude Code session these turn TRANSCRIPT SAVING
  // OFF, which blinds ClaudeCodeController (its primary signal is the JSONL
  // transcript) and silently degrades detection to terminal-idle heuristics.
  const env = { ...process.env };
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.CLAUDECODE;

  const cleanup = async () => {
    try {
      sock?.end();
    } catch {}
    if (mux && mux.exitCode === null) {
      try {
        mux.kill("SIGTERM");
      } catch {}
      await sleep(1200);
      if (mux.exitCode === null) {
        try {
          mux.kill("SIGKILL");
        } catch {}
      }
    }
  };

  try {
    mux = spawn("magmux", ["--headless", "--id", opts.id, "-e", "claude"], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
      cwd: opts.cwd,
    });

    for (let i = 0; i < 60 && !sock; i++) {
      await sleep(500);
      sock = await new Promise<Socket | null>((res) => {
        const s = connect(sockPath);
        s.on("connect", () => res(s));
        s.on("error", () => res(null));
      });
    }
    if (!sock) return { ok: false, answer: "", costSeen: false, states, reason: "no_socket" };

    let buf = "";
    let msgs: any[] = [];
    sock.on("data", (d) => {
      buf += d.toString();
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) {
          try {
            msgs.push(JSON.parse(line));
          } catch {
            // Not our protocol; ignore rather than kill the driver.
          }
        }
        i = buf.indexOf("\n");
      }
    });

    let nid = 1;
    const send = (o: any) => sock!.write(`${JSON.stringify({ ...o, id: nid++ })}\n`);
    const paneState = (): string | null => {
      for (let k = msgs.length - 1; k >= 0; k--) {
        const panes = msgs[k]?.result?.panes ?? msgs[k]?.panes;
        if (Array.isArray(panes)) {
          const p = panes.find((x: any) => x.pane === 0);
          if (p?.state) return p.state;
        }
      }
      return null;
    };
    const waitFor = async (want: string[], label: string, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        msgs = [];
        send({ type: "list" });
        await sleep(600);
        const st = paneState();
        if (st) {
          if (want.includes(st)) {
            states.push(`${label}=${st}`);
            log(`${label}: ${st}`);
            return st;
          }
          if (st === "awaiting_permission") {
            states.push(`${label}=awaiting_permission`);
            return st;
          }
        }
      }
      states.push(`${label}=TIMEOUT`);
      log(`${label}: TIMEOUT`);
      return null;
    };

    // EDGE 1 — the TUI genuinely at its prompt. `running` here is the SPLASH.
    if (!(await waitFor(["awaiting_input"], "boot", opts.bootMs ?? 90_000)))
      return { ok: false, answer: "", costSeen: false, states, reason: "boot_timeout" };

    send({ type: "send", pane: 0, text: opts.prompt, label: "drive" });

    // EDGE 2 — the turn actually started (guards against a send that never submitted).
    const started = await waitFor(["running"], "started", 30_000);
    if (started === "awaiting_permission")
      return { ok: false, answer: "", costSeen: false, states, reason: "awaiting_permission" };

    // EDGE 3 — the turn actually settled.
    const settled = await waitFor(
      ["awaiting_input", "completed"],
      "settled",
      opts.turnMs ?? 180_000
    );
    if (settled === "awaiting_permission")
      return { ok: false, answer: "", costSeen: false, states, reason: "awaiting_permission" };
    if (!settled) return { ok: false, answer: "", costSeen: false, states, reason: "turn_timeout" };

    // CONTENT is the oracle, not the state flag.
    msgs = [];
    send({ type: "capture", pane: 0, lines: 60 });
    await sleep(1200);
    let screen = "";
    for (let k = msgs.length - 1; k >= 0; k--) {
      const t = msgs[k]?.result?.text ?? msgs[k]?.text;
      if (typeof t === "string") {
        screen = t;
        break;
      }
    }
    const lines = screen
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim());
    const costSeen = /\$\s*[1-9]|\$0\.[0-9]*[1-9]/.test(screen);
    const ansIdx = lines.findIndex((l) => l.trimStart().startsWith("⏺"));
    const answer = ansIdx >= 0 ? lines[ansIdx].replace(/^\s*⏺\s*/, "").trim() : "";

    send({ type: "close_pane", pane: 0, force: false });
    await sleep(2000);

    return { ok: answer.length > 0 && costSeen, answer, costSeen, states };
  } finally {
    await cleanup();
  }
}

if (import.meta.main) {
  const id = process.argv[2] ?? "drv1";
  const prompt = process.argv[3] ?? "Reply with exactly OK and nothing else.";
  const r = await driveClaude({ id, prompt, cwd: process.cwd() });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
