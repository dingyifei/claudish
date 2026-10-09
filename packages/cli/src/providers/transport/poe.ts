/**
 * PoeProvider — Poe API transport.
 *
 * Transport concerns:
 * - Bearer token auth (POE_API_KEY)
 * - Fixed endpoint: https://api.poe.com/v1/chat/completions
 * - Standard OpenAI SSE format
 */

import { credentials } from "../../auth/credentials/authority.js";
import type { DiscoveryOutcome } from "./probe-discovery.js";
import { discoverProviderProbeModel } from "./provider-model-discovery.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

const POE_API_URL = "https://api.poe.com/v1/chat/completions";

export class PoeProvider implements ProviderTransport {
  readonly name = "poe";
  readonly displayName = "Poe";
  readonly streamFormat: StreamFormat = "openai-sse";

  getEndpoint(): string {
    return POE_API_URL;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const auth = await credentials.getRequestAuth("poe", { model: "" });
    return auth.headers;
  }

  /**
   * Pick a probe model from the account's own list.
   *
   * The catalog marks Poe `no_verified_probe_model`, so without this Test All
   * reported "no probe model: transport does not support discovery" and never
   * sent a request, although Poe answers normally: measured 2026-09-19, its
   * /v1/models returns 341 models and a chat request returns 200.
   */
  async discoverProbeModel(exclude?: ReadonlySet<string>): Promise<DiscoveryOutcome> {
    return discoverProviderProbeModel(this.name, this.displayName, exclude);
  }
}
