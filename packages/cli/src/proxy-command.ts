/**
 * `claudish proxy` — manage persistent proxy daemons.
 *
 *   claudish proxy list                 List running daemons (port, pid, model, uptime, idle)
 *   claudish proxy stop <port>          Stop the daemon on <port>
 *   claudish proxy stop --all           Stop every running daemon
 *
 * Daemons are spawned by `claudish --persist-proxy`; each self-registers a
 * record in ~/.claudish/proxies/. See proxy-daemon.ts.
 */
import {
  type DaemonRecord,
  isPidAlive,
  listDaemons,
  readDaemonRecords,
  removeDaemonRecord,
} from "./proxy-daemon.js";

function fmtAge(fromMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${mins % 60}m`;
}

function listCommand(): void {
  const now = Date.now();
  const daemons = listDaemons();
  if (daemons.length === 0) {
    console.log("No running claudish proxy daemons.");
    return;
  }
  const rows = daemons.map((d) => ({
    port: String(d.port),
    pid: String(d.pid),
    model: d.model,
    uptime: fmtAge(d.startedAt, now),
    url: d.url,
  }));
  const cols: Array<{ key: keyof (typeof rows)[0]; head: string }> = [
    { key: "port", head: "PORT" },
    { key: "pid", head: "PID" },
    { key: "model", head: "MODEL" },
    { key: "uptime", head: "UPTIME" },
    { key: "url", head: "URL" },
  ];
  const width = (key: keyof (typeof rows)[0]) =>
    Math.max(cols.find((c) => c.key === key)!.head.length, ...rows.map((r) => r[key].length));
  const line = (get: (c: (typeof cols)[0]) => string) =>
    cols.map((c) => get(c).padEnd(width(c.key))).join("  ");
  console.log(line((c) => c.head));
  for (const r of rows) console.log(line((c) => r[c.key]));
}

function stopRecord(rec: DaemonRecord): boolean {
  if (!isPidAlive(rec.pid)) {
    removeDaemonRecord(rec.port);
    return false;
  }
  try {
    // The daemon's SIGTERM handler shuts the proxy down and removes its record.
    process.kill(rec.pid, "SIGTERM");
    return true;
  } catch (err) {
    console.error(
      `[claudish proxy] failed to stop pid ${rec.pid} on port ${rec.port}: ${err instanceof Error ? err.message : err}`
    );
    return false;
  }
}

function stopCommand(target: string | undefined): void {
  // Read raw records (not liveness-pruned) so `stop` still cleans up a stale
  // record for a port the user explicitly names.
  const records = readDaemonRecords();

  if (target === "--all") {
    if (records.length === 0) {
      console.log("No claudish proxy daemons to stop.");
      return;
    }
    let stopped = 0;
    for (const rec of records) if (stopRecord(rec)) stopped++;
    console.log(`Stopped ${stopped} daemon(s).`);
    return;
  }

  if (!target) {
    console.error("Usage: claudish proxy stop <port> | --all");
    process.exit(1);
  }

  const port = Number.parseInt(target, 10);
  if (Number.isNaN(port)) {
    console.error(`Invalid port: ${target}`);
    process.exit(1);
  }
  const rec = records.find((r) => r.port === port);
  if (!rec) {
    console.error(`No proxy daemon found on port ${port}.`);
    process.exit(1);
  }
  if (stopRecord(rec)) console.log(`Stopped daemon on port ${port} (pid ${rec.pid}).`);
  else console.log(`No live daemon on port ${port} — removed stale record.`);
}

export async function proxyCommand(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "list":
    case "ls":
    case undefined:
      listCommand();
      return;
    case "stop":
    case "kill":
      stopCommand(args[1]);
      return;
    default:
      console.error(`Unknown proxy subcommand: ${sub}`);
      console.error("Usage: claudish proxy [list] | proxy stop <port>|--all");
      process.exit(1);
  }
}
