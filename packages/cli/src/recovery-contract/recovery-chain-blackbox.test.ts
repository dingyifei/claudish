/**
 * CONTRACT POINT 6 — a connection failure must NEVER advance the provider
 * chain. This is the criterion that separates a fix from a bill: a chain that
 * advances during an outage can move a subscription user onto metered billing.
 *
 * Trap T-12 is the whole design of this file. "No advance" asserted on a chain
 * that COULD NOT have advanced — one candidate, or a second candidate with no
 * credential — is vacuous and passes on any build at all. So:
 *   • the chain here is genuinely multi-candidate (two custom endpoints, both
 *     constructible, both credentialled);
 *   • the POSITIVE CONTROL in the same file drives the same shape of chain into
 *     an advance and proves candidate 2 is reachable and would have served;
 *   • "did it advance?" is answered at CANDIDATE 2's OWN SOCKET — a request
 *     count on a server we own — not by grepping the proxy's log for
 *     `[Fallback]`, which is written by the code under test.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type HealthyFixture,
  type ProxyHandle,
  type RawFixture,
  endpointsConfig,
  envSnapshot,
  postMessage,
  reservePorts,
  startHealthyFixture,
  startProxy,
  startRawFixture,
  startStatusFixture,
} from "./fixtures.js";

let restoreEnv: (() => void) | undefined;
let proxy: ProxyHandle | undefined;
const stoppables: { stop(): void }[] = [];

afterEach(async () => {
  await proxy?.shutdown();
  proxy = undefined;
  while (stoppables.length > 0) stoppables.pop()?.stop();
  restoreEnv?.();
  restoreEnv = undefined;
});

const SECOND = "SECOND-CANDIDATE-ANSWER";

function setEnv(apiTimeoutMs: number): void {
  restoreEnv = envSnapshot(["API_TIMEOUT_MS", "CLAUDISH_RECOVERY"]);
  process.env.API_TIMEOUT_MS = String(apiTimeoutMs);
  delete process.env.CLAUDISH_RECOVERY;
}

async function startChain(opts: {
  firstUrl?: string;
  firstPort?: number;
  secondPort: number;
}): Promise<ProxyHandle> {
  const config = endpointsConfig([
    {
      name: "ep-one",
      port: opts.firstPort ?? 0,
      model: "m-one",
      ...(opts.firstUrl ? { url: opts.firstUrl } : {}),
    },
    { name: "ep-two", port: opts.secondPort, model: "m-two" },
  ]);
  const handle = await startProxy(config, {
    model: "ep-one@m-one",
    modelChain: ["ep-one@m-one", "ep-two@m-two"],
    quiet: false,
    captureStderr: true,
  });
  proxy = handle;
  return handle;
}

describe("CP-6 — a connection failure never switches providers", () => {
  test("POSITIVE CONTROL: the same chain DOES advance on a retryable upstream status", async () => {
    setEnv(40_000);
    const [firstPort, secondPort] = reservePorts(2);
    const first = startStatusFixture(429, firstPort);
    const second: HealthyFixture = startHealthyFixture(SECOND, secondPort);
    stoppables.push(first, second);

    const handle = await startChain({ firstPort, secondPort });
    const result = await postMessage(handle.url, { model: "ep-one@m-one" });

    expect(result.status).toBe(200);
    expect(result.body).toContain(SECOND);
    // Candidate 2 was reachable, credentialled and willing — asserted at its
    // own socket. Without this, the no-advance test below is vacuous.
    expect(second.requests.length).toBe(1);
    expect(first.hits).toBeGreaterThanOrEqual(1);
    expect(handle.stderr()).toContain("trying next provider");
  }, 60_000);

  test("an unreachable candidate 1 retries in place and candidate 2 is never contacted", async () => {
    setEnv(40_000);
    const [firstPort, secondPort] = reservePorts(2);
    const first: RawFixture = startRawFixture(firstPort);
    const second: HealthyFixture = startHealthyFixture(SECOND, secondPort);
    stoppables.push(first, second);

    const handle = await startChain({ firstPort, secondPort });
    const result = await postMessage(handle.url, { model: "ep-one@m-one" });

    // The ladder ran on candidate 1 …
    expect(first.connections.length).toBeGreaterThanOrEqual(2);
    // … and candidate 2 never saw a byte. Counted at candidate 2's socket.
    expect(second.requests.length).toBe(0);
    expect(result.body).not.toContain(SECOND);
    expect(JSON.parse(result.body).error.type).toBe("connection_error");
    expect(handle.stderr()).not.toContain("trying next provider");
  }, 60_000);

  test("CONTROL: a neutral DNS failure retries in place and does not advance", async () => {
    // Isolates the variable for the wording test below: the fault kind is the
    // same (name never resolves), only the words in it differ.
    setEnv(40_000);
    const [secondPort] = reservePorts(1);
    const second: HealthyFixture = startHealthyFixture(SECOND, secondPort);
    stoppables.push(second);

    const handle = await startChain({
      firstUrl: "https://no-such-host-blackbox.invalid/v1",
      secondPort,
    });
    const result = await postMessage(handle.url, { model: "ep-one@m-one" });

    expect(second.requests.length).toBe(0);
    expect(JSON.parse(result.body).error.type).toBe("connection_error");
    expect(result.elapsedMs).toBeGreaterThan(4_000); // the ladder really ran
  }, 60_000);

  test("a connection error whose HOST reads like a billing failure still does not advance", async () => {
    // The wording trap, induced from outside: the error text genuinely
    // contains "quota" because the unreachable host is called that. A
    // classifier that matches on message text rather than on the failure's
    // kind advances the chain here and nowhere else.
    setEnv(40_000);
    const [secondPort] = reservePorts(1);
    const second: HealthyFixture = startHealthyFixture(SECOND, secondPort);
    stoppables.push(second);

    // MEASURED while writing this file: of `quota`, `insufficient-credits`
    // and `rate-limit`, only the substring "quota" flips the outcome — the
    // other two behave exactly like the neutral control above. So the
    // variable really is the WORD, not the fault.
    const badHost = "quota-exceeded-insufficient-credits.invalid";
    // P-2: a hijacking resolver would turn this into an ordinary HTTP
    // failure and silently invert the scenario. Fail loudly, never skip.
    let resolved = false;
    try {
      await fetch(`https://${badHost}/v1`, { signal: AbortSignal.timeout(3_000) });
      resolved = true;
    } catch {
      resolved = false;
    }
    expect(
      resolved,
      `PRECONDITION P-2 FAILED: ${badHost} answered. This machine's resolver hijacks .invalid, ` +
        "so the DNS fault is not in force."
    ).toBe(false);

    const handle = await startChain({
      firstUrl: `https://${badHost}/v1`,
      secondPort,
    });
    const result = await postMessage(handle.url, { model: "ep-one@m-one" });

    expect(second.requests.length).toBe(0);
    expect(result.body).not.toContain(SECOND);
    expect(handle.stderr()).not.toContain("trying next provider");
    const err = JSON.parse(result.body).error;
    expect(err.type).toBe("connection_error");
    expect(err.message.toLowerCase()).not.toContain("billing");
  }, 60_000);
});
