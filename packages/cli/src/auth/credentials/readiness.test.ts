/**
 * Credential readiness — proving that a credential FAILURE is distinguishable
 * from credential ABSENCE, and that nothing else moved.
 *
 * ── What this file exists to catch ───────────────────────────────────────────
 * `isAvailable()` is a boolean with one slot for two facts. Every resolution
 * failure collapsed into `false`, which downstream reads as "this user has no
 * key for this provider": `hasCredentialsForProvider` drops the candidate from
 * the routing chain and a metered provider serves the request with nothing
 * printed. A locked Mac, a denied 1Password handshake or a keychain ACL the
 * user declined therefore moved a flat-rate subscriber onto pay-per-token, in
 * silence.
 *
 * A first attempt at the fix produced `"failed"` ONLY when a source threw — and
 * no production source throws. The tests below deliberately drive the two
 * measured failure modes through their real code paths (a `security` that
 * exits non-zero, a 1Password handshake that fails) rather than by making a
 * fake provider throw, because a throw-only oracle passes a throw-only test
 * while the actual bug is untouched.
 *
 * ── The two invariants ───────────────────────────────────────────────────────
 *  1. `failed` ≠ `absent`. The SAME provider, the SAME environment, differing
 *     only in whether the store answered, must produce two different verdicts.
 *  2. Routing is byte-identical: `isAvailable(name)` is exactly
 *     `describeReadiness(name).readiness === "present"`, so `failed` still
 *     keeps a candidate out of the chain. `equivalence.test.ts` is the pin on
 *     the matrix; this file pins the projection itself, per verdict.
 *
 * ── Hermetic strategy ────────────────────────────────────────────────────────
 * NO `mock.module()` anywhere: Bun's module registry is process-global and a
 * stub bleeds into sibling files. The keychain is driven entirely through the
 * production `setKeychainTestDeps()` seam (platform / run / runAsync) against a
 * temp config file, so NO test here can reach the real login keychain — killing
 * `security` processes restarts `securityd` and drops the authenticated
 * keychain session of every app on the machine. 1Password is driven through
 * `__setOpSourceSeamsForTests` (in-memory config + fake SDK factory + stub
 * auth), and is otherwise held off with the production `CLAUDISH_DISABLE_OP`
 * escape hatch.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigFileOverride, setConfigFileOverride } from "../../config-override.js";
import type { KeychainDeps, KeychainRunResult } from "../../providers/keychain.js";
import { invalidateKeychainCache, setKeychainTestDeps } from "../../providers/keychain.js";
import type { SdkAuth, SdkClientFactory, SdkClientLike } from "../../providers/onepassword.js";
import {
  resetOpFailures,
  setAppLockProbe,
  setLockRetryTiming,
  setPeerLockProbe,
  setScreenLockProbe,
} from "../../providers/onepassword.js";
import type { AntigravityTokenDeps } from "../antigravity-token.js";
import { readSharedAntigravityToken } from "../antigravity-token.js";
import {
  __resetResolveCacheForTests,
  __resetSdkAuthForTests,
  __resetSniffForTests,
  __resetWarnOnceForTests,
  __setOpSourceSeamsForTests,
} from "./op-source.js";
import type { CredentialProvider, ReadinessResult, RequestAuth } from "./types.js";

// ── Import ORDER matters here, which is why these are dynamic ───────────────
//
// `authority.ts` builds its `credentials` singleton at module scope, and that
// constructor references the provider classes it imports. Those providers sit
// in an import CYCLE with the authority (antigravity-credential reaches it
// through the transport/catalog modules). Naming a provider module first in a
// static import list makes IT the entry point, so the authority's module body
// runs while the class it is about to construct is still in its temporal dead
// zone — "Cannot access 'AntigravityCredentialProvider' before initialization",
// at import time, before a single test runs. Loading the authority FIRST lets
// it pull every provider in the order it already works in; by the time the
// lines below run, each module is fully initialised.
const { CredentialAuthority } = await import("./authority.js");
const { ApiKeyCredentialProvider } = await import("./api-key-credential.js");
const { CompositeCredentialProvider } = await import("./composite-credential.js");
const { AntigravityCredentialProvider } = await import("./antigravity-credential.js");
const { DevinCredentialProvider } = await import("./devin-credential.js");
const { GrokSubscriptionCredentialProvider } = await import("./grok-credential.js");

type CredentialAuthorityInstance = InstanceType<typeof CredentialAuthority>;
type ApiKeyProviderInstance = InstanceType<typeof ApiKeyCredentialProvider>;

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A real captured `security dump-keychain` block (attributes only — the command
 * runs without `-d`, so it never reads item DATA). Reused from
 * keychain-source.test.ts rather than hand-authored.
 */
const REAL_DUMP_BLOCK = `keychain: "/Users/jack/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="claudish: CLAUDISH_READINESS_TEST_API_KEY"
    "acct"<blob>="CLAUDISH_READINESS_TEST_API_KEY"
    "cdat"<timedate>=0x32303236303832323132333235385A00
    "desc"<blob>="application password"
    "icmt"<blob>="Stored by claudish"
    "svce"<blob>="claudish"`;

/** The measured stderr of a `security` invocation that could not be answered. */
const LOCKED_STDERR = "security: SecKeychainSearchCopyNext: User interaction is not allowed.";

const ENV_VAR = "CLAUDISH_READINESS_TEST_API_KEY";
const OTHER_ENV_VAR = "CLAUDISH_READINESS_TEST_OTHER_API_KEY";
const TOUCHED_ENV_VARS = [ENV_VAR, OTHER_ENV_VAR] as const;

const OP_ENVIRONMENT_ID = "readiness-test-env";
const STUB_AUTH: SdkAuth = { kind: "token", token: "ops_test" };

// ── Shared hermetic state ───────────────────────────────────────────────────

let tempDirectory: string;
let configFile: string;
let savedConfigOverride: string | null;
let savedEnv: Map<string, string | undefined>;
let savedDisableKeychain: string | undefined;
let savedDisableOp: string | undefined;
let savedArgv: string[];
let runCalls: string[][];
let runImpl: KeychainDeps["run"];

function runResult(code: number, stdout = "", stderr = ""): KeychainRunResult {
  return { code, stdout, stderr };
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(configFile, JSON.stringify(config));
  // The op sniff reads the config file directly and memoizes; a rewrite must
  // invalidate it or the next `hasOpSources()` answers about the old file.
  __resetSniffForTests();
}

/** Turn the keychain backend ON for this test, through the real config flag. */
function enableKeychain(): void {
  writeConfig({ keychain: { enabled: true } });
  delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  // The engine memoizes enumeration for a 3-second burst, INCLUDING failures.
  // Each case scripts a different `security` answer, so the memo must go.
  invalidateKeychainCache();
}

/** A provider whose ONLY possible credential source is the keychain. */
function keychainOnlyProvider(envVar = ENV_VAR): ApiKeyProviderInstance {
  return new ApiKeyCredentialProvider({ catalogName: `readiness-${envVar}`, envVar });
}

beforeEach(() => {
  savedConfigOverride = getConfigFileOverride();
  savedDisableKeychain = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  savedDisableOp = process.env.CLAUDISH_DISABLE_OP;
  savedArgv = process.argv;

  tempDirectory = mkdtempSync(join(tmpdir(), "claudish-readiness-"));
  configFile = join(tempDirectory, "config.json");
  setConfigFileOverride(configFile);
  writeConfig({});

  savedEnv = new Map(TOUCHED_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of TOUCHED_ENV_VARS) delete process.env[name];

  // Default posture: BOTH vaults off. A test that wants one turns it on
  // explicitly, so nothing here can reach a real store by omission.
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  process.env.CLAUDISH_DISABLE_OP = "1";
  process.argv = ["bun", "readiness.test.ts"];

  runCalls = [];
  runImpl = () => {
    throw new Error("unexpected keychain call — a test must script `runImpl` first");
  };
  setKeychainTestDeps({
    platform: () => "darwin",
    run: (args, stdin) => {
      runCalls.push([...args]);
      return runImpl(args, stdin);
    },
    runAsync: async (args, stdin) => {
      runCalls.push([...args]);
      return runImpl(args, stdin);
    },
  });
  invalidateKeychainCache();

  __resetSdkAuthForTests();
  __resetSniffForTests();
  __resetWarnOnceForTests();
  __resetResolveCacheForTests();
  __setOpSourceSeamsForTests(undefined);
  resetOpFailures();
  setLockRetryTiming({ seconds: 0.01, tickMs: 1 });
  setScreenLockProbe(() => false);
  setAppLockProbe(() => false);
  setPeerLockProbe(() => false);
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (savedDisableKeychain === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedDisableKeychain;
  if (savedDisableOp === undefined) delete process.env.CLAUDISH_DISABLE_OP;
  else process.env.CLAUDISH_DISABLE_OP = savedDisableOp;
  process.argv = savedArgv;

  setKeychainTestDeps(null);
  invalidateKeychainCache();
  setConfigFileOverride(savedConfigOverride);
  rmSync(tempDirectory, { recursive: true, force: true });

  __resetSdkAuthForTests();
  __resetSniffForTests();
  __resetWarnOnceForTests();
  __resetResolveCacheForTests();
  __setOpSourceSeamsForTests(undefined);
  resetOpFailures();
  setLockRetryTiming();
  setScreenLockProbe(undefined);
  setAppLockProbe(undefined);
  setPeerLockProbe(undefined);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A scriptable CredentialProvider with no tri-state of its own. */
class LegacyProvider implements CredentialProvider {
  constructor(
    readonly catalogName: string,
    private readonly answer: boolean | Error
  ) {}

  async isAvailable(): Promise<boolean> {
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }

  async getRequestAuth(): Promise<RequestAuth> {
    return { headers: {} };
  }
}

/**
 * Assert invariant 2 — `isAvailable` is the `=== "present"` projection, per
 * verdict rather than only across a matrix. A provider that reports `failed`
 * and `true` would be a routing change hiding behind a richer type.
 */
async function expectProjection(
  authority: CredentialAuthorityInstance,
  name: string
): Promise<ReadinessResult> {
  const described = await authority.describeReadiness(name);
  expect(await authority.isAvailable(name)).toBe(described.readiness === "present");
  return described;
}

/** A fake 1Password whose Environment fetch always fails with `message`. */
function opEnvironmentThatFails(message: string): SdkClientFactory {
  const client: SdkClientLike = {
    secrets: {
      async resolve(ref: string): Promise<string> {
        throw new Error(`readiness tests resolve no refs: ${ref}`);
      },
      async resolveAll() {
        return { individualResponses: {} };
      },
    },
    vaults: {
      async list() {
        return [];
      },
    },
    items: {
      async list() {
        return [];
      },
      async get() {
        throw new Error("readiness tests must not inspect items");
      },
    },
    environments: {
      async getVariables() {
        throw new Error(message);
      },
    },
  };
  return async () => client;
}

/** A fake 1Password whose Environment answers cleanly, holding `vars`. */
function opEnvironmentHolding(vars: Record<string, string>): SdkClientFactory {
  const client: SdkClientLike = {
    secrets: {
      async resolve(ref: string): Promise<string> {
        throw new Error(`readiness tests resolve no refs: ${ref}`);
      },
      async resolveAll() {
        return { individualResponses: {} };
      },
    },
    vaults: {
      async list() {
        return [];
      },
    },
    items: {
      async list() {
        return [];
      },
      async get() {
        throw new Error("readiness tests must not inspect items");
      },
    },
    environments: {
      // The SDK's real shape is `{ variables: [{ name, value }] }`. An EMPTY
      // array is not "holds nothing" — `readEnvironment` throws on it,
      // deliberately, because an Environment fetch is all-or-nothing and an
      // empty answer cannot be told apart from a wrong id.
      async getVariables() {
        return {
          variables: Object.entries(vars).map(([name, value]) => ({
            name,
            value,
            masked: false,
          })),
        };
      },
    },
  };
  return async () => client;
}

/** Install the in-memory 1Password seam and turn the sync sniff back on. */
function enableOp(factory: SdkClientFactory): void {
  delete process.env.CLAUDISH_DISABLE_OP;
  __setOpSourceSeamsForTests({
    config: { onepassword: [], onepasswordEnvironments: [OP_ENVIRONMENT_ID] },
    sdkFactory: factory,
    auth: STUB_AUTH,
  });
  __resetSniffForTests();
}

/**
 * 1Password configured with exactly `config`, and an AMBIENT handshake that is
 * denied — the measured failure shape (`Denied authorization for SDK client`),
 * driven through the production path rather than through a throwing fake.
 *
 * `auth` is deliberately NOT set: it stands in for a SUCCESSFUL ambient resolve
 * and would short-circuit the branch under test. `ambientAuthFailure` is what
 * keeps this hermetic — without it `getSdkAuth()` runs `op account list` against
 * the developer's real machine.
 */
function enableOpWithAmbientFailure(
  config: { apiKeys?: Record<string, string>; onepassword?: string[] },
  message: string
): void {
  delete process.env.CLAUDISH_DISABLE_OP;
  __setOpSourceSeamsForTests({
    config: { onepassword: [], onepasswordEnvironments: [], ...config },
    ambientAuthFailure: message,
  });
  __resetSniffForTests();
}

/** Silence the deliberate stderr warnings a failing store emits. */
async function quietly<T>(body: () => Promise<T>): Promise<T> {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The authority's tri-state, and the projection that keeps routing still
// ═══════════════════════════════════════════════════════════════════════════

describe("CredentialAuthority.describeReadiness — the three values", () => {
  it("reports an UNREGISTERED provider as absent, never failed", async () => {
    const authority = new CredentialAuthority();
    // Nothing was consulted, so there is no failure to report. This is the one
    // place `absent` is the honest answer to "we did not ask".
    expect(await expectProjection(authority, "no-such-provider")).toEqual({ readiness: "absent" });
  });

  it("reports a provider with no credential as absent", async () => {
    const authority = new CredentialAuthority();
    authority.register(new LegacyProvider("legacy-absent", false));

    expect(await expectProjection(authority, "legacy-absent")).toEqual({ readiness: "absent" });
  });

  it("reports a credentialed provider as present", async () => {
    const authority = new CredentialAuthority();
    authority.register(new LegacyProvider("legacy-present", true));

    expect(await expectProjection(authority, "legacy-present")).toEqual({ readiness: "present" });
  });

  it("reports a THROWING source as failed, with the reason, never as absent", async () => {
    const authority = new CredentialAuthority();
    authority.register(
      new LegacyProvider("legacy-throws", new Error("keychain is locked\nsecond line dropped"))
    );

    const described = await expectProjection(authority, "legacy-throws");
    expect(described.readiness).toBe("failed");
    expect(described.detail).toBe("keychain is locked");
  });

  it("still keeps a failed provider OUT of the chain — isAvailable is false", async () => {
    const authority = new CredentialAuthority();
    authority.register(new LegacyProvider("legacy-throws", new Error("denied")));

    // This is invariant 2 stated as money: `failed` must not become a licence
    // to route. A credential that will not resolve cannot sign a request.
    expect(await authority.isAvailable("legacy-throws")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE HEADLINE — a keychain that could not be READ is not a keychain that
//    is EMPTY. Driven through the real `security` path, not through a throw.
// ═══════════════════════════════════════════════════════════════════════════

describe("macOS Keychain: failure vs absence", () => {
  it("distinguishes a keychain that could not be read from one holding nothing", async () => {
    // Case A — the store answered, and it holds nothing for this variable.
    enableKeychain();
    runImpl = () => runResult(0, "");
    const absent = await quietly(() => keychainOnlyProvider().describeReadiness());

    // Case B — the SAME provider, the SAME (empty) environment. The only thing
    // that differs is that `security` could not answer.
    enableKeychain();
    runImpl = () => runResult(1, "", LOCKED_STDERR);
    const failed = await quietly(() => keychainOnlyProvider().describeReadiness());

    expect(absent.readiness).toBe("absent");
    expect(failed.readiness).toBe("failed");
    // The whole point, in one assertion: two different answers to two different
    // questions. Collapse them and this line is the one that goes red.
    expect(failed.readiness).not.toBe(absent.readiness);
  });

  it("names the store in the failure detail, and carries `security`'s own reason", async () => {
    enableKeychain();
    runImpl = () => runResult(1, "", LOCKED_STDERR);

    const described = await quietly(() => keychainOnlyProvider().describeReadiness());

    expect(described.readiness).toBe("failed");
    // "unlock your keychain" and "buy the subscription you already own" are
    // different remedies; the detail is what lets a caller offer the right one.
    expect(described.detail).toContain("Keychain");
    expect(described.detail).toContain("User interaction is not allowed");
  });

  it("reports an unreadable ITEM as failed, not as an absent item", async () => {
    // Enumeration succeeds and lists the variable, so the item exists — the
    // per-item read is what was refused (a declined ACL). Absence is disproven
    // by the enumeration itself, so this can only be `failed`.
    //
    // Exit 1, NOT 44: 44 is `security`'s measured "genuinely absent" signal and
    // reporting that as a failure would be the over-report this whole change
    // exists to avoid. Only a read that could not be performed is `failed`.
    enableKeychain();
    runImpl = (args) =>
      args[0] === "dump-keychain" ? runResult(0, REAL_DUMP_BLOCK) : runResult(1, "", LOCKED_STDERR);

    const described = await quietly(() => keychainOnlyProvider().describeReadiness());

    expect(described.readiness).toBe("failed");
  });

  it("keeps routing unchanged: isAvailable is false for BOTH absent and failed", async () => {
    enableKeychain();
    runImpl = () => runResult(0, "");
    expect(await quietly(() => keychainOnlyProvider().isAvailable())).toBe(false);

    enableKeychain();
    runImpl = () => runResult(1, "", LOCKED_STDERR);
    expect(await quietly(() => keychainOnlyProvider().isAvailable())).toBe(false);
  });

  it("does NOT cache a failure — the next call retries and can succeed", async () => {
    enableKeychain();
    const provider = keychainOnlyProvider();

    runImpl = () => runResult(1, "", LOCKED_STDERR);
    expect((await quietly(() => provider.describeReadiness())).readiness).toBe("failed");

    // The user unlocked the keychain. A cached failure would pin this provider
    // as credential-less for the life of the process — the compounding bug
    // architecture/keychain.md records.
    invalidateKeychainCache();
    runImpl = (args) =>
      args[0] === "dump-keychain"
        ? runResult(0, REAL_DUMP_BLOCK)
        : runResult(0, "sk-recovered-value\n");

    expect(await provider.describeReadiness()).toEqual({ readiness: "present" });
  });

  it("does not let a broken keychain downgrade a provider whose key is in env", async () => {
    // A store that is never consulted cannot make a provider look broken. The
    // cheap env check runs first, by design.
    enableKeychain();
    process.env[ENV_VAR] = "sk-from-the-shell";
    runImpl = () => runResult(1, "", LOCKED_STDERR);

    expect(await keychainOnlyProvider().describeReadiness()).toEqual({ readiness: "present" });
    expect(runCalls).toHaveLength(0);
  });

  it("reports absent — not failed — when the backend is simply not enabled", async () => {
    // The over-report guard. Every user who has not opted into the keychain
    // must stay `absent`, or every provider starts reporting errors.
    expect(await keychainOnlyProvider().describeReadiness()).toEqual({ readiness: "absent" });
    expect(runCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 1Password — `onAuthFailure: "skip"` must skip the EXCEPTION, not the REASON
// ═══════════════════════════════════════════════════════════════════════════

describe("1Password: a swallowed failure is still a failure", () => {
  it("reports a failed handshake as failed, not as absent", async () => {
    enableOp(opEnvironmentThatFails("1Password desktop bridge unavailable (test)"));

    const described = await quietly(() => keychainOnlyProvider().describeReadiness());

    expect(described.readiness).toBe("failed");
    expect(described.detail).toContain("1Password");
  });

  it("reports absent when 1Password answers cleanly and holds nothing", async () => {
    // The other half of the over-report guard: a working vault that does not
    // carry this key is an ANSWER. Turning it into `failed` would mark every
    // unconfigured provider broken for every 1Password user.
    enableOp(opEnvironmentHolding({ SOMETHING_ELSE_API_KEY: "sk-unrelated" }));

    expect(await keychainOnlyProvider().describeReadiness()).toEqual({ readiness: "absent" });
  });

  it("reports failed for EVERY provider in a chain, not just the first to ask", async () => {
    // The trap that makes a call-site `getOpFailures()` check wrong: both the
    // stderr warning and the run-scoped failure record are de-duplicated on
    // purpose, so the second provider to hit the same denial sees no new
    // evidence. A bare model name filters a whole chain of candidates, so
    // "only the first one learns" means the rest get billed metered silently.
    enableOp(opEnvironmentThatFails("1Password desktop bridge unavailable (test)"));

    const verdicts = await quietly(async () => [
      await keychainOnlyProvider(ENV_VAR).describeReadiness(),
      await keychainOnlyProvider(OTHER_ENV_VAR).describeReadiness(),
    ]);

    expect(verdicts.map((v) => v.readiness)).toEqual(["failed", "failed"]);
  });

  it("keeps routing unchanged: a failed 1Password resolve is still unavailable", async () => {
    enableOp(opEnvironmentThatFails("1Password desktop bridge unavailable (test)"));

    expect(await quietly(() => keychainOnlyProvider().isAvailable())).toBe(false);
  });

  // ── The OVER-report guard, from the other side (HIGH Issue 2) ─────────────
  //
  // Revert control for the pair below: delete the `sourcesCouldHoldWanted` test
  // inside `noteFailure` in op-source.ts. The first goes red — `failed` for a
  // provider no configured source names — while the second stays green, which is
  // the asymmetry that makes this a control rather than a coincidence.

  it("does NOT attribute an ambient handshake failure to a provider no source names", async () => {
    // A metered-only user with an unrelated explicit `op://` reference for some
    // OTHER provider, and a 1Password that will not answer. Nothing configured
    // here could ever hold this provider's key, so the honest verdict is that
    // the user has none — `absent`.
    //
    // This matters as more than tidiness: routing reads `failed` as "a real
    // subscription key exists and could not be read" and says so on stderr. The
    // over-report would tell the user that a subscription they never bought
    // could not be read.
    enableOpWithAmbientFailure(
      { apiKeys: { UNRELATED_OTHER_API_KEY: "op://vault/item/UNRELATED_OTHER_API_KEY" } },
      "Denied authorization for SDK client"
    );

    expect(await quietly(() => keychainOnlyProvider().describeReadiness())).toEqual({
      readiness: "absent",
    });
  });

  it("DOES report failed when a BROAD source could have held it — a glob is not knowable", async () => {
    // The other half. A glob's contents cannot be known without reading it, so a
    // read that failed leaves the question genuinely open, and `failed` is the
    // honest answer. Narrowing this to explicit refs only would reintroduce the
    // unanimous CRITICAL for every user who imports by glob.
    enableOpWithAmbientFailure(
      { onepassword: ["op://vault/API Keys/*"] },
      "Denied authorization for SDK client"
    );

    const described = await quietly(() => keychainOnlyProvider().describeReadiness());
    expect(described.readiness).toBe("failed");
    expect(described.detail).toContain("1Password");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The composite must not flatten a half's `failed` back into a boolean
// ═══════════════════════════════════════════════════════════════════════════

describe("CompositeCredentialProvider readiness", () => {
  it("forwards a failed fallback instead of reporting absent", async () => {
    // kimi and openai-codex are composites whose FALLBACK half is the only
    // thing that ever touches the keychain or 1Password. Flatten here and the
    // tri-state is dead on arrival for exactly the subscription providers it
    // exists to protect.
    enableKeychain();
    runImpl = () => runResult(1, "", LOCKED_STDERR);
    const composite = new CompositeCredentialProvider(
      "composite-test",
      new LegacyProvider("oauth-half", false),
      keychainOnlyProvider()
    );

    const described = await quietly(() => composite.describeReadiness());

    expect(described.readiness).toBe("failed");
    expect(await quietly(() => composite.isAvailable())).toBe(false);
  });

  it("short-circuits on a present primary — a broken fallback never downgrades it", async () => {
    enableKeychain();
    runImpl = () => runResult(1, "", LOCKED_STDERR);
    const composite = new CompositeCredentialProvider(
      "composite-test",
      new LegacyProvider("oauth-half", true),
      keychainOnlyProvider()
    );

    expect(await composite.describeReadiness()).toEqual({ readiness: "present" });
    expect(runCalls).toHaveLength(0);
  });

  it("reports absent when both halves are cleanly absent", async () => {
    const composite = new CompositeCredentialProvider(
      "composite-test",
      new LegacyProvider("oauth-half", false),
      new LegacyProvider("key-half", false)
    );

    expect(await composite.describeReadiness()).toEqual({ readiness: "absent" });
    expect(await composite.isAvailable()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The blast radius is every provider — the `catch { return false }` sites
// ═══════════════════════════════════════════════════════════════════════════

describe("subscription providers report the tri-state", () => {
  // ANTIGRAVITY IS DELIBERATELY NOT IN THIS LOOP, and must not be added back.
  //
  // The loop calls the REAL provider with no stub. `AntigravityCredentialProvider`
  // reads its token through `auth/antigravity-token.ts`, whose `defaultReadStore`
  // spawns `security` — and none of the three existing protections reaches it:
  //
  //   · `setKeychainTestDeps()` stubs `providers/keychain.ts` only. The two are
  //     separable precisely because antigravity resolves a BARE `"security"`
  //     through `PATH` while keychain.ts uses the absolute `/usr/bin/security`
  //     (architecture/keychain.md).
  //   · `CLAUDISH_DISABLE_KEYCHAIN=1` appears nowhere in `antigravity-token.ts`,
  //     so not even `bun run test:safe` prevents the spawn.
  //   · The injection seam is a DEFAULT PARAMETER, and the provider calls it with
  //     no argument — a test cannot intervene from outside.
  //
  // So the loop read the developer's real shared agy token on every run, in a
  // repository whose own rule is that a safe target must EXIST rather than
  // relying on care. It stayed green either way, which is what made it invisible.
  // Antigravity's contract is covered below, through the parameter seam.
  const providers: [string, CredentialProvider][] = [
    ["devin", new DevinCredentialProvider()],
    ["grok-subscription", new GrokSubscriptionCredentialProvider()],
  ];

  for (const [name, provider] of providers) {
    it(`${name} implements describeReadiness and projects isAvailable from it`, async () => {
      // These three swallowed every error into `return false`, so a store that
      // could not be asked was reported as a user who never subscribed — and
      // `gk@` / `dv@` / `ag@` fell through to a metered vendor in silence.
      expect(typeof provider.describeReadiness).toBe("function");

      const described = await provider.describeReadiness?.({});
      expect(described).toBeDefined();
      const readiness = described?.readiness ?? "(none returned)";
      expect(["present", "absent", "failed"]).toContain(readiness);
      expect(await provider.isAvailable()).toBe(readiness === "present");
    });
  }

  it("a provider whose store read throws is failed, via the authority", async () => {
    // The shared contract behind all three: the authority is the backstop for
    // any source that still raises rather than reporting.
    const authority = new CredentialAuthority();
    authority.register(new LegacyProvider("devin", new Error("credentials.toml is a directory")));

    const described = await expectProjection(authority, "devin");
    expect(described.readiness).toBe("failed");
    expect(described.detail).toBe("credentials.toml is a directory");
  });

  // ── Antigravity, through the parameter seam and NOT through `security` ─────

  it("antigravity implements describeReadiness and projects isAvailable from it", () => {
    // Shape only. Calling either one here is what spawns `security`; the VALUE
    // each returns is pinned below, against a stubbed store.
    const provider = new AntigravityCredentialProvider();
    expect(typeof provider.describeReadiness).toBe("function");
    expect(typeof provider.isAvailable).toBe("function");
  });

  it("antigravity's store read drives present / absent / failed through injected deps", () => {
    // `AntigravityCredentialProvider.describeReadiness` is exactly:
    //   readSharedAntigravityToken() !== null  → present : absent, and a THROW
    //   from the store → failed.
    // Every one of those three verdicts is decided by the value this seam
    // returns, so driving the seam covers the tri-state without a subprocess.
    const stub = (readStore: () => string | null): AntigravityTokenDeps => ({
      readStore,
      writeStore: () => {
        throw new Error("readiness tests never write the shared store");
      },
      runAgyRefresh: () => ({ kind: "not-installed" }) as const,
      now: () => Date.parse("2026-08-04T00:00:00.000Z"),
    });

    // present — a real go-keyring-base64 record, built the same way
    // antigravity-token.test.ts builds its fixtures.
    const record = {
      token: {
        access_token: "readiness-access-token",
        token_type: "Bearer",
        refresh_token: "readiness-refresh-token",
        expiry: "2026-08-04T01:00:00.000Z",
      },
      id_token: "readiness-id-token",
      auth_method: "oauth",
    };
    const raw = `go-keyring-base64:${Buffer.from(JSON.stringify(record), "utf8").toString("base64")}`;
    expect(readSharedAntigravityToken(stub(() => raw))?.access_token).toBe(
      "readiness-access-token"
    );

    // absent — the store answered, and it holds nothing.
    expect(readSharedAntigravityToken(stub(() => null))).toBeNull();

    // failed — the store could not be asked. What matters is that the read
    // PROPAGATES rather than swallowing: the provider's `failed` branch is its
    // `catch`, so a read that returned null here would make that branch dead
    // code and collapse "could not ask" back into "not signed in".
    expect(() =>
      readSharedAntigravityToken(
        stub(() => {
          throw new Error("security: User interaction is not allowed.");
        })
      )
    ).toThrow("User interaction is not allowed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The projection invariant, end to end through the authority
// ═══════════════════════════════════════════════════════════════════════════

describe("isAvailable is exactly the `=== present` projection", () => {
  it("holds for present, absent and failed, through a registered ApiKey provider", async () => {
    const authority = new CredentialAuthority();
    authority.register(keychainOnlyProvider());
    const name = `readiness-${ENV_VAR}`;

    // present — resolved from env.
    process.env[ENV_VAR] = "sk-present";
    expect(await expectProjection(authority, name)).toEqual({ readiness: "present" });

    // absent — nothing anywhere, every store consulted and quiet.
    delete process.env[ENV_VAR];
    authority.invalidate(name);
    expect(await expectProjection(authority, name)).toEqual({ readiness: "absent" });

    // failed — the store could not be asked.
    authority.invalidate(name);
    enableKeychain();
    runImpl = () => runResult(1, "", LOCKED_STDERR);
    const failed = await quietly(() => expectProjection(authority, name));
    expect(failed.readiness).toBe("failed");
  });
});
