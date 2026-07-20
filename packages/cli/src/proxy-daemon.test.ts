import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DaemonRecord,
  daemonConfigFromArgv,
  isPidAlive,
  listDaemons,
  readDaemonRecords,
  removeDaemonRecord,
  writeDaemonRecord,
} from "./proxy-daemon.js";

let dir: string;

const rec = (over: Partial<DaemonRecord> = {}): DaemonRecord => ({
  pid: process.pid,
  port: 4000,
  url: "http://127.0.0.1:4000",
  model: "cx@gpt-5.6-sol",
  startedAt: 1_700_000_000_000,
  launcherPid: 1,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-proxies-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("registry read/write", () => {
  test("write then read round-trips a record", () => {
    writeDaemonRecord(rec(), dir);
    const got = readDaemonRecords(dir);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ port: 4000, model: "cx@gpt-5.6-sol", pid: process.pid });
  });

  test("records are returned sorted by port", () => {
    writeDaemonRecord(rec({ port: 4100 }), dir);
    writeDaemonRecord(rec({ port: 4000 }), dir);
    writeDaemonRecord(rec({ port: 4050 }), dir);
    expect(readDaemonRecords(dir).map((r) => r.port)).toEqual([4000, 4050, 4100]);
  });

  test("removeDaemonRecord deletes the file", () => {
    writeDaemonRecord(rec(), dir);
    expect(existsSync(join(dir, "4000.json"))).toBe(true);
    removeDaemonRecord(4000, dir);
    expect(existsSync(join(dir, "4000.json"))).toBe(false);
    expect(readDaemonRecords(dir)).toHaveLength(0);
  });

  test("removeDaemonRecord is a no-op for a missing record", () => {
    expect(() => removeDaemonRecord(9999, dir)).not.toThrow();
  });

  test("missing directory reads as empty", () => {
    expect(readDaemonRecords(join(dir, "nope"))).toEqual([]);
  });

  test("garbled files are skipped, not fatal", () => {
    writeDaemonRecord(rec({ port: 4000 }), dir);
    writeFileSync(join(dir, "4200.json"), "{ not json ");
    writeFileSync(join(dir, "ignore.txt"), "not a record");
    const got = readDaemonRecords(dir);
    expect(got.map((r) => r.port)).toEqual([4000]);
  });
});

describe("liveness pruning", () => {
  test("isPidAlive is true for this process, false for a dead pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    // A very high pid is essentially never a live process.
    expect(isPidAlive(2_000_000_000)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });

  test("listDaemons keeps live records and prunes dead ones", () => {
    writeDaemonRecord(rec({ port: 4000, pid: process.pid }), dir);
    writeDaemonRecord(rec({ port: 4001, pid: 2_000_000_000 }), dir);
    const live = listDaemons(dir);
    expect(live.map((r) => r.port)).toEqual([4000]);
    // The dead record's file is deleted as a side effect.
    expect(existsSync(join(dir, "4001.json"))).toBe(false);
    expect(existsSync(join(dir, "4000.json"))).toBe(true);
  });
});

describe("daemonConfigFromArgv", () => {
  test("returns the JSON blob following the flag", () => {
    const argv = ["node", "claudish", "--proxy-daemon", '{"port":4000}'];
    expect(daemonConfigFromArgv(argv)).toBe('{"port":4000}');
  });

  test("returns '{}' when the flag has no following value", () => {
    expect(daemonConfigFromArgv(["node", "claudish", "--proxy-daemon"])).toBe("{}");
  });

  test("returns null when the flag is absent", () => {
    expect(daemonConfigFromArgv(["node", "claudish", "--model", "gpt-4o"])).toBeNull();
  });
});
