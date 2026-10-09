/**
 * A real proxy in a REAL CHILD PROCESS, for the observations that cannot be
 * made in-process:
 *
 *  • which FILE DESCRIPTOR a diagnostic took. An in-process
 *    `process.stderr.write` monkeypatch cannot tell stdout from stderr — it
 *    intercepts the call, not the fd. This project has a terminal-isolation
 *    module precisely because a stray write corrupted a client's TUI.
 *  • whether the process EXITS after a recovery episode, which is invisible to
 *    a test running inside it: a live 60s timer keeps the loop alive.
 *
 * Usage (all arguments positional):
 *   bun child-proxy-run.ts <mode> <endpointUrl> <apiTimeoutMs> [abortAfterMs]
 *   mode: "exhaust" | "abort"
 *
 * stdout carries exactly one JSON result line, and nothing else may appear
 * there. Everything diagnostic belongs on stderr.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigFileOverride } from "../config-override.js";
import { createProxyServer } from "../proxy-server.js";

const [mode, endpointUrl, apiTimeoutMs, abortAfterMs] = process.argv.slice(2);

// A distinctive secret: nothing the proxy prints may ever contain it.
const SECRET_KEY = "sk-blackbox-SECRET-VALUE-9f3c1d";

process.env.API_TIMEOUT_MS = apiTimeoutMs ?? "40000";
delete process.env.CLAUDISH_RECOVERY;

const dir = mkdtempSync(join(tmpdir(), "recovery-child-"));
const configPath = join(dir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    customEndpoints: {
      "ep-child": {
        kind: "simple",
        url: endpointUrl,
        format: "openai",
        apiKey: SECRET_KEY,
        models: ["m-child"],
      },
    },
  }),
  "utf8"
);
setConfigFileOverride(configPath);

const proxy = await createProxyServer(0, undefined, undefined, false, undefined, undefined, {
  quiet: false,
});

const body = JSON.stringify({
  model: "ep-child@m-child",
  max_tokens: 32,
  messages: [{ role: "user", content: "hello" }],
});

const controller = new AbortController();
if (mode === "abort") {
  setTimeout(() => controller.abort(), Number(abortAfterMs ?? 7000));
}

const started = Date.now();
let status = 0;
let text = "";
let aborted = false;
try {
  const res = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: controller.signal,
  });
  status = res.status;
  text = await res.text();
} catch {
  aborted = true;
}

const requestMs = Date.now() - started;
const shutdownStarted = Date.now();
await proxy.shutdown();
const shutdownMs = Date.now() - shutdownStarted;

process.stdout.write(
  `${JSON.stringify({ mode, status, aborted, requestMs, shutdownMs, bodyPrefix: text.slice(0, 200) })}\n`
);
process.exit(0);
