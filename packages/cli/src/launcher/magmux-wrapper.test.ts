/**
 * The launch wrapper.
 *
 * Two of these assertions are about SECURITY (only deltas reach the disk, and
 * the file is 0600) and two are about a contract that fails silently if it
 * breaks (the exports come after the login shell, and the strip list is
 * applied). The rest pin the gate: an implementation that wrapped `-p`, a
 * non-TTY, or a machine without magmux would break surfaces that have nothing
 * to do with this feature.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  STRIPPED_CHILD_VARS,
  buildLauncherScript,
  envDeltas,
  magmuxPaneCapability,
  planMagmuxWrap,
} from "./magmux-wrapper.js";

const roots: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "claudish-wrap-test-"));
  roots.push(d);
  return d;
}

afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE = {
  claudeBinary: "/usr/local/bin/claude",
  claudeArgs: ["--dangerously-skip-permissions"],
  interactive: true,
  stdoutIsTty: true,
  magmuxBinary: "/opt/homebrew/bin/magmux",
  pid: 4242,
};

describe("envDeltas", () => {
  test("carries ONLY what claudish changed — never the inherited environment", () => {
    // The difference between a delta and a dump is whether the user's exported
    // secrets end up in a file on disk.
    const parent = { PATH: "/usr/bin", HOME: "/Users/jack", OPENAI_API_KEY: "sk-secret" };
    const child = { ...parent, ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" };
    const { set, unset } = envDeltas(parent, child);
    expect(set).toEqual([["ANTHROPIC_BASE_URL", "http://127.0.0.1:8787"]]);
    expect(set.map(([k]) => k)).not.toContain("OPENAI_API_KEY");
    expect(set.map(([k]) => k)).not.toContain("PATH");
    expect(unset).toEqual([...STRIPPED_CHILD_VARS]);
  });

  test("a CHANGED value is a delta; an identical one is not", () => {
    const parent = { A: "1", B: "2" };
    const child = { A: "1", B: "changed" };
    expect(envDeltas(parent, child).set).toEqual([["B", "changed"]]);
  });

  test("a variable claudish deleted is unset, not silently inherited", () => {
    // Monitor mode deletes ANTHROPIC_API_KEY so Claude Code uses its own
    // credentials. If the login shell re-inherited it, the session would bill
    // the API instead of the subscription.
    const parent = { ANTHROPIC_API_KEY: "sk-real" };
    const child = {};
    expect(envDeltas(parent, child).unset).toContain("ANTHROPIC_API_KEY");
  });

  test("CLAUDECODE and CLAUDE_CODE_CHILD_SESSION are always unset, never exported", () => {
    // Inherited, the pair turns transcript saving off and degrades magmux's own
    // controller to terminal-idle heuristics. `claude-runner.ts` spreads
    // `...process.env` and strips only the first.
    const parent = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1" };
    const child = { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", X: "y" };
    const { set, unset } = envDeltas(parent, child);
    expect(set.map(([k]) => k)).not.toContain("CLAUDECODE");
    expect(set.map(([k]) => k)).not.toContain("CLAUDE_CODE_CHILD_SESSION");
    expect(unset).toContain("CLAUDECODE");
    expect(unset).toContain("CLAUDE_CODE_CHILD_SESSION");
  });
});

describe("buildLauncherScript", () => {
  test("exports come AFTER the profile and immediately before exec — that is the point", () => {
    // RISK-5, measured rather than assumed: a live `list` reply shows magmux
    // runs a pane command as `/bin/zsh -l -c …`. A user's `.zprofile` therefore
    // runs between claudish and Claude Code, and claudish's whole contract with
    // Claude Code — starting with ANTHROPIC_BASE_URL — travels in the
    // environment. Re-asserting after the profile is what survives it.
    const script = buildLauncherScript("/usr/local/bin/claude", ["-i"], {
      set: [["ANTHROPIC_BASE_URL", "http://127.0.0.1:8787"]],
      unset: ["CLAUDECODE"],
    });
    const lines = script.trim().split("\n");
    const exportAt = lines.findIndex((l) => l.startsWith("export ANTHROPIC_BASE_URL="));
    const execAt = lines.findIndex((l) => l.startsWith("exec "));
    expect(exportAt).toBeGreaterThan(-1);
    expect(execAt).toBe(lines.length - 1);
    expect(exportAt).toBeLessThan(execAt);
  });

  test("values and arguments are single-quoted, so a space or a quote cannot escape", () => {
    const script = buildLauncherScript("/path with space/claude", ["it's", "--flag"], {
      set: [["WEIRD", "a'b c"]],
      unset: [],
    });
    expect(script).toContain(`export WEIRD='a'\\''b c'`);
    expect(script).toContain(`exec '/path with space/claude' 'it'\\''s' '--flag'`);
  });
});

describe("planMagmuxWrap", () => {
  test("returns null for a non-interactive run — `-p` and `--stdin` are untouched", () => {
    expect(
      planMagmuxWrap({ ...BASE, interactive: false, childEnv: {}, tmpRoot: scratch() })
    ).toBeNull();
  });

  test("returns null when stdout is not a TTY", () => {
    expect(
      planMagmuxWrap({ ...BASE, stdoutIsTty: false, childEnv: {}, tmpRoot: scratch() })
    ).toBeNull();
  });

  test("returns null INSIDE an existing magmux — a grid pane must not nest one", () => {
    // `team --grid --mode interactive` runs one `claudish -i` per pane, each
    // interactive with a real TTY. Without this, every slot would wrap itself
    // in a second magmux inside the pane it is already running in. magmux
    // exports MAGMUX_SOCK to its children precisely so a child can tell.
    expect(
      planMagmuxWrap({
        ...BASE,
        parentEnv: { MAGMUX_SOCK: "/tmp/magmux-someone-else.sock" },
        childEnv: {},
        tmpRoot: scratch(),
      })
    ).toBeNull();
  });

  test("returns null when magmux is missing — the session launches exactly as before", () => {
    // The correct degradation, and it needs no version check: without a
    // multiplexer nothing can open a pane, so no lease is ever granted and the
    // feature is simply absent.
    expect(
      planMagmuxWrap({ ...BASE, magmuxBinary: null, childEnv: {}, tmpRoot: scratch() })
    ).toBeNull();
  });

  test("the control socket path is DERIVED from --id, so it is known before magmux starts", () => {
    // claudish is magmux's parent and `MAGMUX_SOCK` is exported downward only,
    // so a pid-derived socket could never be discovered by the parent. `--id`
    // is what makes the recovery UI reachable at all.
    const plan = planMagmuxWrap({ ...BASE, childEnv: {}, tmpRoot: scratch() });
    expect(plan).not.toBeNull();
    expect(plan?.controlSocket).toBe("/tmp/magmux-claudish-4242.sock");
    expect(plan?.args).toContain("--id");
    expect(plan?.args[plan.args.indexOf("--id") + 1]).toBe("claudish-4242");
  });

  test("passes --no-idle-done, -w and --no-status", () => {
    const plan = planMagmuxWrap({ ...BASE, childEnv: {}, tmpRoot: scratch() });
    // `--no-idle-done` is the fix for the `-w` trap: an idle pane is a resting
    // session, not a finished one, and with the flag `-w` waits for the process
    // to exit rather than for a turn to end.
    expect(plan?.args).toContain("--no-idle-done");
    expect(plan?.args).toContain("-w");
    expect(plan?.args).toContain("--no-status");
  });

  test("the pane command SOURCES the generated script", () => {
    const plan = planMagmuxWrap({ ...BASE, childEnv: {}, tmpRoot: scratch() });
    const cmd = plan?.args[plan.args.length - 1] as string;
    expect(cmd.startsWith(". '")).toBe(true);
    expect(cmd).toContain(plan?.scriptPath as string);
  });

  test("the script is 0600 inside a 0700 directory and carries only the deltas", () => {
    const root = scratch();
    const plan = planMagmuxWrap({
      ...BASE,
      parentEnv: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-inherited-secret" },
      childEnv: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-inherited-secret",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      },
      tmpRoot: root,
    });
    const script = readFileSync(plan?.scriptPath as string, "utf-8");
    expect(script).toContain("export ANTHROPIC_BASE_URL='http://127.0.0.1:8787'");
    // The inherited secret is NOT written to disk. This is the assertion that
    // makes "only the deltas" a property rather than a comment.
    expect(script).not.toContain("sk-inherited-secret");
    expect(script).not.toContain("PATH=");
    expect(statSync(plan?.scriptPath as string).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(plan?.scriptPath as string)).mode & 0o777).toBe(0o700);
  });

  test("MAGMUX_SCROLLBACK defaults to 10000 but never overrides the user's own", () => {
    // RISK-4: the pane replaces the emulator's native scrollback with magmux's
    // ring. A bigger ring does not give selection back, but it stops the
    // session's history from being the thing that is lost.
    const a = planMagmuxWrap({ ...BASE, childEnv: {}, tmpRoot: scratch() });
    expect(a?.env.MAGMUX_SCROLLBACK).toBe("10000");
    const b = planMagmuxWrap({
      ...BASE,
      childEnv: { MAGMUX_SCROLLBACK: "500" },
      tmpRoot: scratch(),
    });
    expect(b?.env.MAGMUX_SCROLLBACK).toBe("500");
  });

  test("the magmux process itself never inherits the stripped variables", () => {
    const plan = planMagmuxWrap({
      ...BASE,
      childEnv: { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", KEEP: "yes" },
      tmpRoot: scratch(),
    });
    expect(plan?.env.CLAUDECODE).toBeUndefined();
    expect(plan?.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(plan?.env.KEEP).toBe("yes");
  });

  test("cleanup removes the script and its directory", () => {
    const root = scratch();
    const plan = planMagmuxWrap({ ...BASE, childEnv: {}, tmpRoot: root });
    expect(statSync(plan?.scriptPath as string).isFile()).toBe(true);
    plan?.cleanup();
    expect(() => statSync(plan?.scriptPath as string)).toThrow();
  });

  test("the pane exit code starts unknown — magmux's own status is not the child's", () => {
    // Measured: pane 0 exited 42 while magmux stayed alive waiting for a second
    // pane, so the exit code has to come off the control socket's `exit` event.
    const plan = planMagmuxWrap({ ...BASE, childEnv: {}, tmpRoot: scratch() });
    expect(plan?.paneExitCode()).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The launcher script is a SECRET on disk
// ───────────────────────────────────────────────────────────────────────────

describe("the script's directory is unguessable and cannot be pre-created", () => {
  /**
   * The file this guards is sourced by the LOGIN SHELL immediately before
   * `exec`, and it carries claudish's env deltas — including, on the proxy
   * path, the `ANTHROPIC_API_KEY` Claude Code authenticates to us with.
   *
   * It used to live at `<tmp>/claudish-launch-<pid>`, created with
   * `mkdirSync(..., { recursive: true })`. `recursive: true` neither throws on
   * `EEXIST` nor applies `mode` to a directory that already exists, and the
   * name contains only the pid, which is enumerable — so on a multi-user host
   * another uid could pre-create (or symlink) that path and have it adopted
   * without a word, then read the session's secrets or swap the script between
   * the write and the `exec`. CWE-377 / CWE-59.
   */
  test("the path does not contain the pid, and two plans never collide", () => {
    const root = scratch();
    const a = planMagmuxWrap({ ...BASE, childEnv: {}, tmpRoot: root });
    const b = planMagmuxWrap({ ...BASE, childEnv: {}, tmpRoot: root });

    // Same pid, same tmpRoot, different directory: the name is random, so it
    // cannot be pre-created by someone who knows the pid.
    expect(dirname(a?.scriptPath as string)).not.toBe(dirname(b?.scriptPath as string));
    expect(a?.scriptPath).not.toContain(String(BASE.pid));
    expect(statSync(dirname(a?.scriptPath as string)).mode & 0o777).toBe(0o700);
    expect(statSync(a?.scriptPath as string).mode & 0o777).toBe(0o600);
  });

  test("a directory planted at the OLD predictable path is never adopted", () => {
    // The attack, verbatim: another uid creates the path first — world-writable
    // or a symlink into its own tree — and waits for claudish to write the
    // session's environment into it. `recursive: true` adopted it silently and
    // left its mode alone, and `writeFileSync` follows whatever is already
    // there. `mkdtempSync` + `wx` makes both impossible.
    const root = scratch();
    const planted = join(root, `claudish-launch-${BASE.pid}`);
    mkdirSync(planted, { recursive: true, mode: 0o777 });
    const decoy = join(planted, "claude-launch.sh");
    writeFileSync(decoy, "# planted");

    const plan = planMagmuxWrap({
      ...BASE,
      childEnv: { ANTHROPIC_API_KEY: "sk-session-secret" },
      tmpRoot: root,
    });

    expect(dirname(plan?.scriptPath as string)).not.toBe(planted);
    // The secret did not land anywhere the planter can read.
    expect(readFileSync(decoy, "utf-8")).toBe("# planted");
    expect(readFileSync(plan?.scriptPath as string, "utf-8")).toContain("sk-session-secret");
    expect(statSync(dirname(plan?.scriptPath as string)).mode & 0o777).toBe(0o700);
  });

  test("a plan that is never watched still takes its secret off disk at exit", () => {
    // `watch()` cleans up on the CHILD's exit, which covers the ordinary path
    // only. A SIGTERM to claudish, or a launch that never spawns, would
    // otherwise leave the key in /tmp.
    const plan = planMagmuxWrap({ ...BASE, childEnv: {}, tmpRoot: scratch() });
    expect(process.listeners("exit").length).toBeGreaterThan(0);
    plan?.cleanup();
    expect(() => statSync(plan?.scriptPath as string)).toThrow();
    // Idempotent, and it unhooks itself: a long-lived host must not accumulate
    // one exit listener per launch.
    plan?.cleanup();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Eligibility, asked separately because the watchdog has to ask it EARLY
// ───────────────────────────────────────────────────────────────────────────

describe("magmuxPaneCapability", () => {
  test("wrap when interactive, on a TTY, with a binary and no ambient socket", () => {
    expect(
      magmuxPaneCapability({
        interactive: true,
        stdoutIsTty: true,
        magmuxBinary: "/opt/homebrew/bin/magmux",
        parentEnv: {},
      })
    ).toEqual({ kind: "wrap", magmux: "/opt/homebrew/bin/magmux" });
  });

  test("ambient inside someone else's magmux — a pane is reachable without wrapping", () => {
    // `team --grid --mode interactive`, or a user who launched claudish in a
    // pane by hand. Nothing to wrap, but there IS a multiplexer to ask.
    expect(
      magmuxPaneCapability({
        interactive: true,
        stdoutIsTty: true,
        magmuxBinary: "/opt/homebrew/bin/magmux",
        parentEnv: { MAGMUX_SOCK: "/tmp/magmux-someone-else.sock" },
      })
    ).toEqual({ kind: "ambient", sock: "/tmp/magmux-someone-else.sock" });
  });

  test("none for `-p`, for a pipe, and for a machine without magmux", () => {
    const env = {};
    expect(
      magmuxPaneCapability({ interactive: false, stdoutIsTty: true, parentEnv: env }).kind
    ).toBe("none");
    expect(
      magmuxPaneCapability({ interactive: true, stdoutIsTty: false, parentEnv: env }).kind
    ).toBe("none");
    expect(
      magmuxPaneCapability({
        interactive: true,
        stdoutIsTty: true,
        magmuxBinary: null,
        parentEnv: env,
      }).kind
    ).toBe("none");
  });

  test("it is the SAME predicate planMagmuxWrap uses — they cannot drift", () => {
    // The watchdog is decided from `magmuxPaneCapability` before the child
    // environment is finalised; the wrap is decided from `planMagmuxWrap`
    // afterwards. Two independent gates would mean a launch that exports the
    // ~300-attempt retry budget and then turns out to have no surface for it.
    for (const input of [
      { interactive: false, stdoutIsTty: true },
      { interactive: true, stdoutIsTty: false },
      { interactive: true, stdoutIsTty: true, magmuxBinary: null },
      { interactive: true, stdoutIsTty: true },
    ] as const) {
      const shape = { ...BASE, ...input, childEnv: {}, tmpRoot: scratch(), parentEnv: {} };
      const wrapped = planMagmuxWrap(shape) !== null;
      expect(wrapped).toBe(magmuxPaneCapability(shape).kind === "wrap");
    }
  });
});
