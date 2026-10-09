/**
 * Does the host TUI survive the recovery pane CLOSING?
 *
 * Every Phase-7 capture was taken while the pane was still open — `C-17-final.txt`
 * still has "this pane closes on its own" in it. So the post-close screen was
 * never looked at. This looks at it.
 *
 * Bare PTY, no outer multiplexer, so magmux is the top-level multiplexer exactly
 * as it is for a user who types `claudish` in their own terminal.
 *
 * Usage: bun post-close-render.ts
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VtScreen } from "/Users/jack/mag/claudish/.claude/worktrees/recover/ai-docs/sessions/dev-feature-network-recovery-20260910-110514-0ad0a5a0/phase3/vt.ts";

const ROOT = "/Users/jack/mag/claudish/.claude/worktrees/recover";
const OUT = "/private/tmp/claude-501/-Users-jack-mag-claudish/5ea44449-884c-45a6-99c5-67b0ee7d3998/scratchpad/postclose";
const WORK = join(OUT, "work");
mkdirSync(WORK, { recursive: true });

const CLAUDISH_BIN = join(ROOT, "packages/cli/bin/claudish.cjs");
const PTY_HOST = join(ROOT, "ai-docs/sessions/dev-feature-network-recovery-20260910-110514-0ad0a5a0/phase3/pty-host.py");
const COLS = 120;
const ROWS = 44;
const UPSTREAM = "http://127.0.0.1:11434/v1/chat/completions";

const t0 = Date.now();
const note = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── a port proven free ─────────────────────────────────────────────────────
const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
const DEAD_PORT = probe.port as number;
probe.stop(true);
await sleep(250);
note(`dead port ${DEAD_PORT}`);

const CONFIG = join(OUT, "config.json");
writeFileSync(
  CONFIG,
  JSON.stringify({
    version: 1,
    autoApproveConfirmedAt: new Date().toISOString(),
    customEndpoints: {
      recov: {
        kind: "complex",
        displayName: "Recovery Target",
        transport: "openai",
        baseUrl: `http://127.0.0.1:${DEAD_PORT}`,
        apiPath: "/v1/chat/completions",
        apiKey: "sk-recov",
        streamFormat: "openai-sse",
        models: ["recov-model"],
      },
    },
    predefinedEndpoints: { enabled: false },
  })
);

const vt = new VtScreen(COLS, ROWS);
const child = spawn(
  "python3",
  [PTY_HOST, String(COLS), String(ROWS), CLAUDISH_BIN, "-i", "-d", "--model", "recov@recov-model",
   "--dangerously-skip-permissions", "Reply with exactly one word: banana"],
  {
    cwd: WORK,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDISH_CONFIG: CONFIG, COLUMNS: String(COLS), LINES: String(ROWS), TERM: "xterm-256color" },
  }
);
child.stdout.on("data", (d: Buffer) => vt.write(d.toString("utf-8")));
child.stderr.on("data", () => {});

function debugLog(): string {
  const dir = join(WORK, "logs");
  if (!existsSync(dir)) return "";
  const files = readdirSync(dir).filter((f) => f.endsWith(".log"))
    .map((f) => ({ f, m: Bun.file(join(dir, f)).lastModified })).sort((a, b) => b.m - a.m);
  if (!files[0]) return "";
  try { return readFileSync(join(dir, files[0].f), "utf-8"); } catch { return ""; }
}

// ─── startup prompts ────────────────────────────────────────────────────────
const answered = new Set<string>();
for (let i = 0; i < 60; i++) {
  await sleep(1_000);
  const tail = vt.render().slice(-1200);
  if (!answered.has("update") && /Update now\?/.test(tail)) {
    child.stdin.write("n\n"); answered.add("update"); note("declined update"); continue;
  }
  if (!answered.has("approve") && /Enable auto-approve\?/.test(tail)) {
    child.stdin.write("y\n"); answered.add("approve"); note("accepted auto-approve"); continue;
  }
  if (/Claude Code v|✻|✶|❯ /.test(tail)) { note("Claude Code is up"); break; }
}

// ─── wait for the ladder, then rescue ───────────────────────────────────────
let ladderAt = 0;
for (let i = 0; i < 120; i++) {
  await sleep(1_000);
  if (/\[Recovery\] episode .* opened/.test(debugLog())) { ladderAt = Date.now(); note("ladder opened"); break; }
}
if (!ladderAt) { note("FAIL: ladder never opened"); child.kill("SIGKILL"); process.exit(2); }

await sleep(20_000);
Bun.serve({
  port: DEAD_PORT, hostname: "127.0.0.1", idleTimeout: 240,
  async fetch(req) {
    const body = await req.text();
    return fetch(UPSTREAM, {
      method: "POST", headers: { "content-type": "application/json" },
      body: body.replace(/"model"\s*:\s*"[^"]*"/, '"model":"qwen2.5:0.5b"'),
    });
  },
});
note(`rescue server up on ${DEAD_PORT}`);

// ─── wait for recovery, then for the pane to close ──────────────────────────
let recoveredAt = 0;
for (let i = 0; i < 180; i++) {
  await sleep(1_000);
  if (/\[Recovery\].*recovered after/.test(debugLog())) { recoveredAt = Date.now(); note("recovered"); break; }
}
if (!recoveredAt) { note("FAIL: never recovered"); child.kill("SIGKILL"); process.exit(2); }

writeFileSync(join(OUT, "screen-while-open.txt"), `${vt.render()}\n`);
note("captured screen WHILE the pane is still open");

// PANE_LINGER_MS is 30s. Wait past it, then watch the screen settle.
for (const wait of [32, 36, 42, 50]) {
  while ((Date.now() - recoveredAt) / 1000 < wait) await sleep(500);
  const shot = vt.render();
  writeFileSync(join(OUT, `screen-close+${wait}s.txt`), `${shot}\n`);
  note(`captured at recovered+${wait}s`);
}

// ─── verdict ────────────────────────────────────────────────────────────────
const final = readFileSync(join(OUT, "screen-close+50s.txt"), "utf-8");
const lines = final.split("\n");
const lastContent = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => l.length > 0).pop();
const bottomRow = lastContent ? lastContent[1] : -1;
const blankBelow = ROWS - 1 - bottomRow;
const hasComposer = /^\s*[❯>]\s*$/m.test(final);

console.log("\n================ VERDICT ================");
console.log(`rows                     : ${ROWS}`);
console.log(`last painted row         : ${bottomRow}`);
console.log(`blank rows below it      : ${blankBelow}`);
console.log(`composer (input box) up? : ${hasComposer}`);
console.log(blankBelow > 5 || !hasComposer
  ? "RESULT: BROKEN — chrome stranded / no input box after the pane closed"
  : "RESULT: OK — full-height layout restored after the pane closed");
console.log("=========================================\n");
console.log(final.split("\n").slice(-20).join("\n"));

child.kill("SIGKILL");
await sleep(500);
process.exit(0);
