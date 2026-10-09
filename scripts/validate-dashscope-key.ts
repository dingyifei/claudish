#!/usr/bin/env bun
/**
 * Validate an Alibaba Model Studio (DashScope) PAYG key, outside claudish's routing.
 *
 *   bun scripts/validate-dashscope-key.ts [model ...]
 *
 * The key comes from DASHSCOPE_API_KEY, or, when that is unset, from claudish's own
 * credential store for `qwen-payg` (keychain, config, 1Password). It is never printed:
 * only a masked form is.
 *
 * For each region host it runs:
 *   1. GET  /compatible-mode/v1/models           does the host accept the key at all?
 *   2. POST /compatible-mode/v1/chat/completions  one tiny request per model
 *
 * and classifies each answer, so the three different problems read differently:
 *   KEY REJECTED    the host does not accept this key (wrong region or a bad key)
 *   ACCESS DENIED   the key is valid, but the account may not call this model
 *                   (Model Studio activation, workspace model access, or a RAM policy)
 *   OK              the call worked
 *
 * Alibaba's request ids are printed so their support can trace a denial.
 */

const HOSTS = [
  { region: "international (Singapore)", base: "https://dashscope-intl.aliyuncs.com" },
  { region: "China (Beijing)", base: "https://dashscope.aliyuncs.com" },
];

async function resolveKey(): Promise<{ key: string; source: string }> {
  const fromEnv = process.env.DASHSCOPE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "DASHSCOPE_API_KEY" };
  const { credentials } = await import("../packages/cli/src/auth/credentials/authority.js");
  const auth = await credentials.getRequestAuth("qwen-payg", { model: "probe" });
  const header = auth.headers.Authorization ?? auth.headers.authorization ?? "";
  const key = header.replace(/^Bearer\s+/i, "").trim();
  return { key, source: "claudish credential store (qwen-payg)" };
}

function mask(key: string): string {
  return key.length > 8 ? `${key.slice(0, 3)}••${key.slice(-3)} (length ${key.length})` : "••";
}

function classify(status: number, body: string): string {
  if (status >= 200 && status < 300) return "OK";
  if (/AccessDenied|access denied/i.test(body)) return "ACCESS DENIED";
  if (status === 401 || /InvalidApiKey|Invalid API-key|invalid access token/i.test(body))
    return "KEY REJECTED";
  if (status === 403) return "FORBIDDEN (other)";
  if (status === 404 || /not exist|ModelNotFound/i.test(body)) return "MODEL NOT FOUND";
  if (status === 429) return "RATE LIMITED / QUOTA";
  return `HTTP ${status}`;
}

function requestId(res: Response, body: string): string {
  return (
    res.headers.get("x-request-id") ??
    res.headers.get("x-dashscope-request-id") ??
    /"(?:request_id|id)"\s*:\s*"([^"]+)"/.exec(body)?.[1] ??
    "-"
  );
}

function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const err = parsed.error ?? parsed;
    return [err.code, err.message].filter(Boolean).join(": ") || body.slice(0, 160);
  } catch {
    return body.replace(/\s+/g, " ").slice(0, 160);
  }
}

const { key, source } = await resolveKey();
if (!key) {
  console.error("No key: set DASHSCOPE_API_KEY, or store a qwen-payg key in claudish.");
  process.exit(2);
}
const models = process.argv.slice(2);
console.log(`Key ${mask(key)} from ${source}\n`);

for (const { region, base } of HOSTS) {
  console.log(`== ${region}: ${base}`);
  const listRes = await fetch(`${base}/compatible-mode/v1/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  }).catch((e: Error) => e);
  if (listRes instanceof Error) {
    console.log(`   model list: UNREACHABLE (${listRes.message})\n`);
    continue;
  }
  const listBody = await listRes.text();
  let ids: string[] = [];
  try {
    ids = (JSON.parse(listBody).data ?? []).map((m: { id: string }) => m.id);
  } catch {}
  const listVerdict = classify(listRes.status, listBody);
  console.log(
    `   model list: ${listVerdict}${listVerdict === "OK" ? `, ${ids.length} models` : ` (${errorText(listBody)})`}  request ${requestId(listRes, listBody)}`
  );
  if (listVerdict !== "OK") {
    console.log("");
    continue;
  }

  // With no models given, try the first few text models the account itself lists.
  const toTry =
    models.length > 0
      ? models
      : ids.filter((id) => /^qwen[\d.-]*(plus|max|flash|turbo)/i.test(id)).slice(0, 3);
  for (const model of toTry) {
    const res = await fetch(`${base}/compatible-mode/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Say hi." }],
      }),
      signal: AbortSignal.timeout(60_000),
    }).catch((e: Error) => e);
    if (res instanceof Error) {
      console.log(`   chat ${model}: UNREACHABLE (${res.message})`);
      continue;
    }
    const body = await res.text();
    const verdict = classify(res.status, body);
    const listed = ids.includes(model) ? "listed" : "NOT in the account list";
    console.log(
      `   chat ${model} [${listed}]: ${verdict}${verdict === "OK" ? "" : ` (${errorText(body)})`}  request ${requestId(res, body)}`
    );
  }
  console.log("");
}

console.log(
  [
    "How to read this:",
    "  KEY REJECTED on a host   the key belongs to the other region, or is invalid.",
    "  ACCESS DENIED            the key is valid; in the Model Studio console, check that the",
    "                           service is activated and the key's workspace may call the model.",
    "  OK                       the key works; if claudish still fails, the fault is in claudish.",
  ].join("\n")
);
process.exit(0);

export {};
