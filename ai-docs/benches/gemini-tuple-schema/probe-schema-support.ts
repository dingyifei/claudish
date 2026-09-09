/**
 * LIVE probe: what does the Antigravity/Gemini request validator actually accept
 * in a tool schema?
 *
 * The sanitizer strips anyOf/oneOf/allOf, `format`, and every numeric constraint
 * under a comment asserting Gemini does not support them. That comment predates
 * v7.36.0. This asks the real backend instead of trusting it.
 *
 * Sends one minimal streamGenerateContent per variant and records the status and
 * the validator's message. Variant `control-original-bug` MUST fail: if it does
 * not, the probe is not reaching the validator and every pass below is worthless.
 *
 * Run: bun run ai-docs/sessions/<this-session>/probe-schema-support.ts
 */

import { randomUUID } from "node:crypto";
import {
  antigravityHost,
  buildAntigravityUserAgent,
  getServedAntigravityModels,
  setupAntigravityUser,
} from "../../../packages/cli/src/auth/antigravity-user.js";
import { getValidAntigravityAccessToken } from "../../../packages/cli/src/auth/antigravity-token.js";

type Variant = { name: string; note: string; schema: any };

/** Every variant is the SAME tool, differing only in the `where` property. */
function toolWith(whereSchema: any): any {
  return {
    functionDeclarations: [
      {
        name: "Artifact",
        description: "Query a collection.",
        parameters: {
          type: "object",
          properties: {
            collection: { type: "string", description: "Collection path." },
            where: whereSchema,
          },
          required: ["collection"],
        },
      },
    ],
  };
}

const VARIANTS: Variant[] = [
  {
    name: "control-original-bug",
    note: "nested array whose inner array has no items — MUST fail",
    schema: { type: "array", items: { type: "array" } },
  },
  {
    name: "current-fix-string-items",
    note: "what claudish ships today: collapse to string",
    schema: { type: "array", items: { type: "array", items: { type: "string" } } },
  },
  {
    name: "anyof-inside-items",
    note: "union of the tuple's position types, no `type` alongside",
    schema: {
      type: "array",
      items: {
        type: "array",
        items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
      },
    },
  },
  {
    name: "anyof-with-sibling-type",
    note: "same union but carrying type:string as a sibling",
    schema: {
      type: "array",
      items: {
        type: "array",
        items: {
          type: "string",
          anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
        },
      },
    },
  },
  {
    name: "anyof-top-level-property",
    note: "anyOf on the property itself rather than inside items",
    schema: { anyOf: [{ type: "string" }, { type: "number" }] },
  },
  {
    name: "min-max-items",
    note: "does the validator accept array length constraints?",
    schema: {
      type: "array",
      items: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 },
      maxItems: 10,
    },
  },
  {
    name: "raw-prefixitems",
    note: "send prefixItems untouched — ignored, or rejected as unknown?",
    schema: {
      type: "array",
      items: {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "string" }, { type: "number" }],
      },
    },
  },
  {
    name: "enum-inside-items",
    note: "enum on the element schema",
    schema: {
      type: "array",
      items: { type: "string", enum: ["eq", "ne", "gt"] },
    },
  },
  {
    name: "format-and-numeric-constraints",
    note: "format + minimum/maximum, all stripped today",
    schema: {
      type: "array",
      items: { type: "integer", format: "int32", minimum: 1, maximum: 100 },
    },
  },
  {
    name: "nullable-field",
    note: "nullable, stripped today",
    schema: { type: "array", items: { type: "string", nullable: true } },
  },
];

async function probe(
  variant: Variant,
  token: string,
  projectId: string,
  tierId: string,
  model: string
): Promise<{ name: string; status: number; message: string }> {
  const envelope: any = {
    model,
    project: projectId,
    user_prompt_id: randomUUID(),
    request: {
      contents: [{ role: "user", parts: [{ text: "Say OK." }] }],
      tools: [toolWith(variant.schema)],
    },
  };
  if (tierId && tierId !== "free-tier") envelope.enabled_credit_types = ["GOOGLE_ONE_AI"];

  const res = await fetch(`${antigravityHost()}/v1internal:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": buildAntigravityUserAgent(),
      "x-activity-request-id": randomUUID(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(envelope),
  });

  let message = "";
  if (!res.ok) {
    const body = await res.text();
    try {
      message = JSON.parse(body)?.error?.message ?? body;
    } catch {
      message = body;
    }
  } else {
    // Accepted. Read only the first chunk, then drop the stream — we are asking
    // whether the schema validates, not what the model says.
    const reader = res.body?.getReader();
    if (reader) {
      await reader.read();
      await reader.cancel();
    }
    message = "accepted";
  }
  return { name: variant.name, status: res.status, message: message.slice(0, 240) };
}

const token = await getValidAntigravityAccessToken();
const { projectId, tierId } = await setupAntigravityUser(token);
const served = await getServedAntigravityModels(token, projectId);
const ids: string[] = (served as any).models?.map((m: any) => m.id ?? m.name) ?? [];
const model =
  ids.find((m) => /flash/i.test(m) && !/tab_|chat_/.test(m)) ?? ids[0] ?? "gemini-3.6-flash-high";

console.log(`project=${projectId} tier=${tierId}`);
console.log(`model=${model}`);
console.log(`served=${ids.length} models\n`);

const results: { name: string; status: number; message: string }[] = [];
for (const variant of VARIANTS) {
  try {
    const r = await probe(variant, token, projectId, tierId, model);
    results.push(r);
    console.log(`${r.status === 200 ? "PASS" : "FAIL"} ${r.status}  ${r.name}`);
    if (r.status !== 200) console.log(`        ${r.message}`);
  } catch (err) {
    results.push({ name: variant.name, status: -1, message: String(err) });
    console.log(`ERR   --   ${variant.name}: ${err}`);
  }
}

console.log("\n--- summary ---");
for (const r of results) console.log(`${String(r.status).padStart(4)}  ${r.name}`);

const control = results.find((r) => r.name === "control-original-bug");
if (control && control.status === 200) {
  console.log(
    "\n!! CONTROL PASSED. The probe is not reaching the schema validator; every result above is meaningless."
  );
}
