import { describe, expect, test } from "bun:test";
import { type AntigravityLoginDeps, AntigravityOAuth } from "./antigravity-oauth.js";
import type { AntigravityToken, AntigravityTokenDeps } from "./antigravity-token.js";

const TOKEN: AntigravityToken = {
  access_token: "fake-access-token",
  token_type: "Bearer",
  refresh_token: "fake-refresh-token",
  expiry: "2026-08-04T01:00:00.000Z",
};

interface FakeLoginOptions {
  locateAgy?: AntigravityLoginDeps["locateAgy"];
  hasToken?: AntigravityLoginDeps["hasToken"];
  readToken?: AntigravityLoginDeps["readToken"];
  confirmInstall?: AntigravityLoginDeps["confirmInstall"];
  runInstall?: AntigravityLoginDeps["runInstall"];
  runAgyAuth?: AntigravityLoginDeps["runAgyAuth"];
  onAuthenticated?: AntigravityLoginDeps["onAuthenticated"];
  isInteractive?: AntigravityLoginDeps["isInteractive"];
  now?: AntigravityLoginDeps["now"];
  sleep?: AntigravityLoginDeps["sleep"];
  exit?: AntigravityLoginDeps["exit"];
  timing?: AntigravityLoginDeps["timing"];
}

function makeLoginDeps(options: FakeLoginOptions = {}): AntigravityLoginDeps {
  let now = 0;
  return {
    locateAgy: options.locateAgy ?? (() => null),
    hasToken: options.hasToken ?? (() => false),
    readToken: options.readToken ?? (() => null),
    confirmInstall: options.confirmInstall ?? (async () => false),
    runInstall: options.runInstall ?? (() => false),
    runAgyAuth: options.runAgyAuth ?? (() => {}),
    onAuthenticated: options.onAuthenticated ?? (() => {}),
    isInteractive: options.isInteractive ?? (() => false),
    now: options.now ?? (() => now),
    sleep:
      options.sleep ??
      (async (ms) => {
        now += ms;
      }),
    exit: options.exit ?? (() => {}),
    timing: options.timing ?? { graceMs: 10, intervalMs: 10 },
  };
}

describe("AntigravityOAuth.login", () => {
  test("returns immediately when already authenticated", async () => {
    let authCallCount = 0;
    let installCallCount = 0;
    let readCallCount = 0;
    const deps = makeLoginDeps({
      hasToken: () => true,
      readToken: () => {
        readCallCount += 1;
        return TOKEN;
      },
      runAgyAuth: () => {
        authCallCount += 1;
      },
      runInstall: () => {
        installCallCount += 1;
        return true;
      },
    });

    await expect(AntigravityOAuth.getInstance().login(deps)).resolves.toBeUndefined();

    expect(authCallCount).toBe(0);
    expect(installCallCount).toBe(0);
    expect(readCallCount).toBe(0);
  });

  test("does not install or launch agy when installation is declined", async () => {
    let installCallCount = 0;
    let authCallCount = 0;
    const deps = makeLoginDeps({
      isInteractive: () => true,
      confirmInstall: async () => false,
      runInstall: () => {
        installCallCount += 1;
        return true;
      },
      runAgyAuth: () => {
        authCallCount += 1;
      },
    });

    await expect(AntigravityOAuth.getInstance().login(deps)).resolves.toBeUndefined();

    expect(installCallCount).toBe(0);
    expect(authCallCount).toBe(0);
  });

  test("installs missing agy, locates it again, and launches authentication", async () => {
    let installed = false;
    let installCallCount = 0;
    let locateCallCount = 0;
    let authenticated = false;
    const authCalls: Array<[string, boolean]> = [];
    const deps = makeLoginDeps({
      locateAgy: () => {
        locateCallCount += 1;
        return installed ? "/fake/bin/agy" : null;
      },
      isInteractive: () => true,
      confirmInstall: async () => true,
      runInstall: () => {
        installCallCount += 1;
        installed = true;
        return true;
      },
      runAgyAuth: (agyPath, interactive) => {
        authCalls.push([agyPath, interactive]);
        authenticated = true;
      },
      readToken: () => (authenticated ? TOKEN : null),
    });

    await expect(AntigravityOAuth.getInstance().login(deps)).resolves.toBeUndefined();

    expect(installCallCount).toBe(1);
    expect(locateCallCount).toBe(2);
    expect(authCalls).toEqual([["/fake/bin/agy", false]]);
  });

  test("detects the token written by agy after authentication", async () => {
    let authenticated = false;
    let readCallCount = 0;
    const authCalls: Array<[string, boolean]> = [];
    const deps = makeLoginDeps({
      locateAgy: () => "/fake/bin/agy",
      runAgyAuth: (agyPath, interactive) => {
        authCalls.push([agyPath, interactive]);
        authenticated = true;
      },
      readToken: () => {
        readCallCount += 1;
        return authenticated ? TOKEN : null;
      },
    });

    await expect(AntigravityOAuth.getInstance().login(deps)).resolves.toBeUndefined();

    expect(authCalls).toEqual([["/fake/bin/agy", false]]);
    expect(readCallCount).toBe(1);
  });

  test("completes non-fatally when neither agy launch creates a session", async () => {
    let now = 0;
    const sleepCalls: number[] = [];
    const exitCodes: number[] = [];
    const authCalls: Array<[string, boolean]> = [];
    const deps = makeLoginDeps({
      locateAgy: () => "/fake/bin/agy",
      readToken: () => null,
      runAgyAuth: (agyPath, interactive) => {
        authCalls.push([agyPath, interactive]);
      },
      now: () => now,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        now += ms;
      },
      exit: (code) => {
        exitCodes.push(code);
      },
      timing: { graceMs: 10, intervalMs: 10 },
    });

    await expect(AntigravityOAuth.getInstance().login(deps)).resolves.toBeUndefined();

    expect(authCalls).toEqual([
      ["/fake/bin/agy", false],
      ["/fake/bin/agy", true],
    ]);
    expect(sleepCalls).toEqual([10, 10]);
    expect(exitCodes).toEqual([0]);
  });
});

describe("AntigravityOAuth.logout", () => {
  test("delegates to the injected token-store delete path", async () => {
    let store: string | null = "fake-stored-session";
    let deleteCallCount = 0;
    const tokenDeps: AntigravityTokenDeps = {
      readStore: () => store,
      writeStore: (raw) => {
        store = raw;
      },
      deleteStore: () => {
        deleteCallCount += 1;
        store = null;
      },
      runAgyRefresh: () => ({ kind: "ran" }) as const,
      now: () => 0,
    };

    await expect(AntigravityOAuth.getInstance().logout(tokenDeps)).resolves.toBeUndefined();

    expect(deleteCallCount).toBe(1);
    expect(store).toBeNull();
  });
});
