/**
 * A minimal MCP server whose only tool carries the schema shape that produced
 * the 400: an array of `prefixItems` tuples, with an unconstrained value slot.
 *
 * The tool does no work. It records each received value together with its RUNTIME
 * JSON TYPE, which is the whole point: a 200 only proves the schema was accepted,
 * while the recorded call shows what the model actually did with it — the operator
 * it chose and the type it sent.
 *
 * Set TUPLE_PROBE_RECORD to a file path to append one JSON line per call, and
 * TUPLE_PROBE_LABEL to tag which build produced it.
 */

import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "tuple-probe", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    collection: { type: "string", description: "Collection name." },
    where: {
      type: "array",
      maxItems: 10,
      description: "Filter clauses.",
      items: {
        type: "array",
        prefixItems: [
          { type: "string" },
          { type: "string", enum: ["eq", "ne", "gt", "lt", "gte", "lte"] },
          {},
        ],
      },
    },
  },
  required: ["collection", "where"],
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "query_rows",
      description:
        "Query rows from a collection. Each where clause is [field, operator, value]. " +
        "Pass the value with its natural JSON type — a number stays a number.",
      inputSchema: INPUT_SCHEMA,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as any;
  const clauses = Array.isArray(args.where) ? args.where : [];

  const report = clauses.map((clause: any) => {
    if (!Array.isArray(clause)) return { clause, runtimeTypes: typeof clause };
    return { clause, runtimeTypes: clause.map((v: any) => (v === null ? "null" : typeof v)) };
  });

  const payload = {
    collection: args.collection,
    clauseCount: clauses.length,
    clauses: report,
  };

  // Recorded straight to a file rather than scraped from the terminal. Parsing
  // the TUI was unreliable: the answer can scroll, and the prompt echo itself
  // contains the words being grepped for.
  const record = process.env.TUPLE_PROBE_RECORD;
  if (record) {
    appendFileSync(
      record,
      `${JSON.stringify({ label: process.env.TUPLE_PROBE_LABEL ?? "", ...payload })}\n`
    );
  }
  console.error(`[tuple-probe] ${JSON.stringify(payload)}`);

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
});

await server.connect(new StdioServerTransport());
