/**
 * Capture the demo pane at the moment of recovery and again after the overlay
 * clears — the state the first version never looked at.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PANE = process.argv[2] ?? "%273";
const DEMO = "/private/tmp/claude-501/-Users-jack-mag-claudish--claude-worktrees-recover/5ea44449-884c-45a6-99c5-67b0ee7d3998/scratchpad/demo";
const LOGS = join(DEMO, "work/logs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function capture(): string {
  const out = Bun.spawnSync(["tmux", "capture-pane", "-p", "-t", PANE]).stdout.toString();
  return out
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(3)}  ${l}`)
    .join("\n");
}

function log(): string {
  const f = readdirSync(LOGS).find((n) => n.endsWith(".log"));
  return f ? readFileSync(join(LOGS, f), "utf-8") : "";
}

const deadline = Date.now() + 240_000;
while (!/closed: recovered/.test(log())) {
  if (Date.now() > deadline) {
    console.log("TIMEOUT: never recovered");
    process.exit(1);
  }
  await sleep(250);
}

await sleep(400); // the success banner is written asynchronously after the close
const t0 = new Date().toISOString();
const atRecovery = capture();
await sleep(6_000); // OUTCOME_LINGER_MS is 4 000
const t1 = new Date().toISOString();
const afterTeardown = capture();
const size = Bun.spawnSync(["tmux", "display-message", "-p", "-t", PANE, "#{pane_width}x#{pane_height}"])
  .stdout.toString()
  .trim();

const report = [
  `=== AT RECOVERY ${t0} ===`,
  atRecovery,
  "",
  `=== AFTER TEARDOWN ${t1} (6 s later; linger is 4 s) ===`,
  afterTeardown,
  "",
  `pane size: ${size}`,
].join("\n");
writeFileSync(join(DEMO, "teardown-capture.txt"), report);
console.log(report);
