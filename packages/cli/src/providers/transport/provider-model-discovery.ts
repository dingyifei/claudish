import {
  describeDiscoveryFailure,
  discoverProviderModels,
  getDiscoveryFailure,
  rankDiscoveredModels,
} from "../model-discovery.js";
import { getProviderByName } from "../provider-definitions.js";
import { type DiscoveryOutcome, isChatCapable } from "./probe-discovery.js";

/**
 * Pick a probe model from one provider's authenticated, account-scoped roster.
 *
 * The cloud catalog can publish a useful default, but it cannot know which
 * models a subscription credential serves today. Keeping this rule shared by
 * the OpenAI- and Anthropic-compatible transports prevents a new subscription
 * provider from silently losing endpoint discovery because of its wire format.
 */
export async function discoverProviderProbeModel(
  providerName: string,
  displayName: string,
  exclude?: ReadonlySet<string>
): Promise<DiscoveryOutcome> {
  const def = getProviderByName(providerName);
  if (!def?.modelDiscovery) {
    return {
      model: null,
      reason: `${displayName} publishes no live model list (no modelDiscovery endpoint) — its probe model must come from the cloud catalog`,
    };
  }

  const discovered = await discoverProviderModels(providerName);
  if (discovered.length === 0) {
    const failure = getDiscoveryFailure(providerName);
    return {
      model: null,
      reason: failure
        ? `${displayName}: ${describeDiscoveryFailure(failure)}`
        : `${displayName} listed no models at ${def.modelDiscovery.path} — check the API key and that the subscription is active`,
    };
  }

  const ranked = rankDiscoveredModels(discovered)
    .map((model) => model.id)
    .filter(isChatCapable);
  if (ranked.length === 0) {
    return {
      model: null,
      reason: `no chat-capable model among the ${discovered.length} listed by ${displayName}`,
    };
  }

  const pick = ranked.find((model) => !exclude?.has(model));
  if (!pick) {
    return {
      model: null,
      reason: `all ${ranked.length} candidate model(s) already tried`,
    };
  }
  return { model: pick };
}
