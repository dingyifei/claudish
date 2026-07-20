import { afterEach, describe, expect, test } from "bun:test";
import { createProxyServer } from "./proxy-server.js";
import type { ProxyServer } from "./types.js";

// Exercises the persistent-proxy daemon primitives baked into createProxyServer:
// the /__claudish/health endpoint and the idle self-shutdown timer.

let running: ProxyServer | null = null;
let idleFired = false;

afterEach(async () => {
  if (running && !idleFired) await running.shutdown();
  running = null;
  idleFired = false;
});

async function startProxy(idleTimeoutMs?: number): Promise<ProxyServer> {
  running = await createProxyServer(
    0, // OS-assigned ephemeral port
    undefined,
    undefined,
    false,
    undefined,
    { opus: "cx@gpt-5.6-sol" },
    {
      quiet: true,
      idleTimeoutMs,
      onIdleTimeout: () => {
        idleFired = true;
      },
    }
  );
  return running;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("/__claudish/health", () => {
  test("reports port, model summary, and timestamps", async () => {
    const proxy = await startProxy();
    const res = await fetch(`${proxy.url}/__claudish/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      ok: boolean;
      port: number;
      model: string;
      startedAt: number;
      lastRequestAt: number;
    };
    expect(body.ok).toBe(true);
    expect(body.port).toBe(proxy.port);
    expect(body.model).toBe("cx@gpt-5.6-sol");
    expect(typeof body.startedAt).toBe("number");
  });

  test("health polls do NOT count as activity; /v1/* requests do", async () => {
    // Large idle window so the /v1/* tracking middleware is active but never fires.
    const proxy = await startProxy(60_000);

    const health1 = (await (await fetch(`${proxy.url}/__claudish/health`)).json()) as {
      lastRequestAt: number;
    };
    await sleep(20);
    const health2 = (await (await fetch(`${proxy.url}/__claudish/health`)).json()) as {
      lastRequestAt: number;
    };
    // A health poll must not advance the idle clock.
    expect(health2.lastRequestAt).toBe(health1.lastRequestAt);

    // A real client request under /v1/* advances it.
    await sleep(20);
    await fetch(`${proxy.url}/v1/models`);
    const health3 = (await (await fetch(`${proxy.url}/__claudish/health`)).json()) as {
      lastRequestAt: number;
    };
    expect(health3.lastRequestAt).toBeGreaterThan(health1.lastRequestAt);
  });
});

describe("idle self-shutdown", () => {
  test("fires onIdleTimeout after the idle window with no /v1 traffic", async () => {
    await startProxy(200);
    // checkEvery floors at 250ms; first tick (~250ms) sees idle > 200ms → fires.
    for (let i = 0; i < 20 && !idleFired; i++) await sleep(100);
    expect(idleFired).toBe(true);
  });

  test("no idle timer when idleTimeoutMs is unset", async () => {
    await startProxy(undefined);
    await sleep(400);
    expect(idleFired).toBe(false);
  });
});
