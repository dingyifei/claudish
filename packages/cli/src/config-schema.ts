/**
 * Config schemas for the LiteLLM-demotion refactor (Phase 1).
 *
 * Defines:
 *   - CustomEndpointSimpleSchema    — "URL + format + key" custom endpoints.
 *   - CustomEndpointComplexSchema   — full provider profile (Phase 3 will register).
 *   - CustomEndpointSchema          — discriminated union of the two.
 *
 * `defaultProvider` has no schema. Nothing validated it, and the one that existed
 * rejected `""`, which is a valid value (no fallback provider), and listed
 * `anthropic`, which is not a claudish provider.
 *
 * NOTE: This module is intentionally NOT imported by `profile-config.ts`.
 * Validation happens at the consumption site (Phase 3 will add a
 * `loadCustomEndpoints()` helper that calls Zod and warns on invalid entries).
 * Keeping `profile-config.ts` Zod-free matters because `loadConfig` is called
 * from many lightweight code paths.
 */

import { z } from "zod";

/**
 * How a custom endpoint authenticates.
 *
 * `"none"` exists because there was previously NO WAY to reach an endpoint that
 * wants no credential — a local gateway, an inference server on a trusted
 * network. `apiKey` was `z.string().min(1)`, so `""` failed validation, and any
 * placeholder ("none", "x") was sent as a real `Authorization: Bearer none`
 * header. Reported in #139 by a user whose local router rejected the stray
 * header; the whole entry was refused with `Too small: expected string to have
 * >=1 characters`, which reads as a bug in claudish rather than a missing
 * feature.
 *
 * It is EXPLICIT rather than inferred from an absent `apiKey`. A misspelled key
 * field ("apikey", "api_key") would otherwise silently downgrade an endpoint to
 * unauthenticated and send the user's prompts out with no credential — a failure
 * that looks like it worked. Requiring the declaration means the only way to get
 * no auth is to ask for it.
 */
export const CustomEndpointAuthSchemeSchema = z.enum(["bearer", "x-api-key", "none"]);

/**
 * `apiKey` is required UNLESS `authScheme: "none"`, in which case it must be
 * absent or empty.
 *
 * Written as a refinement rather than two schema variants so the ERROR is
 * actionable in both directions. The old failure told the user their string was
 * too short and left them to guess; these name the field to add.
 */
function requireKeyUnlessNoAuth<
  T extends { apiKey?: string; authScheme?: "bearer" | "x-api-key" | "none" },
>(ep: T, ctx: z.RefinementCtx): void {
  const declared = ep.apiKey?.trim() ?? "";
  if (ep.authScheme === "none") {
    if (declared !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message:
          'authScheme "none" sends no auth header, so apiKey must be omitted. ' +
          "Remove apiKey, or drop authScheme to send it as a bearer token.",
      });
    }
    return;
  }
  if (declared === "") {
    ctx.addIssue({
      code: "custom",
      path: ["apiKey"],
      message:
        "apiKey is required. If this endpoint needs no credential, set " +
        '"authScheme": "none" and omit apiKey entirely.',
    });
  }
}

// "Simple" custom endpoint: just URL + format + key.
// Reuses existing OpenAI/Anthropic format converters and a generic transport.
export const CustomEndpointSimpleSchema = z
  .object({
    kind: z.literal("simple"),
    url: z.url(),
    format: z.enum(["openai", "anthropic"]),
    // Optional so `authScheme: "none"` can omit it; the refinement below still
    // requires it for every other scheme.
    apiKey: z.string().optional(),
    // `simple` used to have no authScheme at all and hardcoded bearer. It is
    // accepted here ONLY so a keyless endpoint does not have to be rewritten as
    // `kind: "complex"` just to say "no auth" — the narrowest widening that
    // closes #139 for the shape the reporter actually used.
    authScheme: CustomEndpointAuthSchemeSchema.optional(),
    modelPrefix: z.string().optional(),
    models: z.array(z.string()).optional(),
  })
  .superRefine(requireKeyUnlessNoAuth);

// "Complex" custom endpoint: a runtime PROVIDER_PROFILES entry.
// All ProviderProfile fields, with reasonable defaults documented in Phase 3.
export const CustomEndpointComplexSchema = z
  .object({
    kind: z.literal("complex"),
    displayName: z.string(),
    transport: z.enum(["openai", "anthropic", "gemini", "ollamacloud", "litellm"]),
    baseUrl: z.url(),
    apiPath: z.string().optional(),
    apiKey: z.string().optional(),
    authScheme: CustomEndpointAuthSchemeSchema.optional(),
    headers: z.record(z.string(), z.string()).optional(),
    streamFormat: z
      .enum(["openai-sse", "openai-responses-sse", "gemini-sse", "anthropic-sse", "ollama-jsonl"])
      .optional(),
    modelPrefix: z.string().optional(),
    models: z.array(z.string()).optional(),
  })
  .superRefine(requireKeyUnlessNoAuth);

export const CustomEndpointSchema = z.discriminatedUnion("kind", [
  CustomEndpointSimpleSchema,
  CustomEndpointComplexSchema,
]);

/**
 * Opt-out surface for the BUNDLED endpoint catalog (`predefined-catalog.ts`).
 *
 *   "predefinedEndpoints": {
 *     "enabled": false,              // the whole catalog is off
 *     "disable": ["groq"],           // individual opt-out, case-insensitive
 *     "enable":  ["tuningengines"]   // activate despite no locally-present key
 *   }
 *
 * `enable` exists because activation is otherwise inferred from a credential
 * being present SYNCHRONOUSLY, and a key that lives only behind an `op://`
 * reference cannot be seen without the async 1Password path — which the gate
 * deliberately cannot reach. It is also the answer for a keyless self-hosted
 * gateway sitting behind network auth.
 *
 * `disable` beats `enable`: refusals beat permissions, the same rule that puts
 * the collision check ahead of the credential gate.
 *
 * NOT `.strict()`, deliberately — an unknown key here is a forward-compat
 * config from a newer claudish, and the right response to that is to honour the
 * keys we understand, not to discard the block. Unknown NAMES in `disable` /
 * `enable` are likewise a silent no-op: a user who opts out of a vendor that is
 * later dropped from the bundle should not collect a warning on every launch
 * for a line that is now simply inert.
 */
export const PredefinedEndpointsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  disable: z.array(z.string()).optional(),
  enable: z.array(z.string()).optional(),
});

export type CustomEndpointSimple = z.infer<typeof CustomEndpointSimpleSchema>;
export type CustomEndpointComplex = z.infer<typeof CustomEndpointComplexSchema>;
export type CustomEndpoint = z.infer<typeof CustomEndpointSchema>;
export type PredefinedEndpointsConfig = z.infer<typeof PredefinedEndpointsConfigSchema>;
