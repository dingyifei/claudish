/**
 * picker/PickerDataSource.ts — the four slow things the picker needs, behind one
 * interface, plus the production implementation that wraps the existing functions
 * verbatim.
 *
 * THIS SEAM EXISTS BECAUSE THE STATES THAT MATTER CANNOT BE PHOTOGRAPHED
 * OTHERWISE. The whole feature is about what the picker shows when discovery
 * FAILS, serves nothing, or is still in flight — and of those, only "unauthorized"
 * is reproducible against a live provider (a bogus key, a real 401). An empty
 * dynamic models catalog, a dynamic models catalog where nothing is chat-capable, a network timeout and the
 * in-flight frames themselves are not reachable from outside, and the warm catalog
 * path settles faster than a screenshot can catch. So the loaders are a parameter,
 * a scriptable fake drives the capture runs, and the production impl is the
 * default.
 *
 * NOT `mock.module()`: mocking shared infrastructure bleeds across Bun's module
 * registry and breaks sibling e2e files (`feedback_no_mock_module_bleed`). An
 * injected interface cannot leak into another test file.
 *
 * EVERY MEMBER'S SYNC/ASYNC SHAPE IS PART OF THE CONTRACT.
 *
 *   · `providerList`, `displayName`, `notEnabledLocalProviders`,
 *     `discoveryShape` are SYNCHRONOUS because the first frame must be complete
 *     before any await, and because the in-flight indicator's SHAPE has to be
 *     chosen before the fetch it describes begins.
 *   · `servedModels` is SYNCHRONOUS, and that is the decision that makes one flat
 *     cross-provider list affordable at all. It reads the catalog's local
 *     served-by index; the async `loadModelsForPickerProvider` asks the same
 *     question with a live `?provider=` query per owner slug, and 22 of those
 *     fired together were MEASURED at 10 s returning zero rows. `servedByVendor`
 *     in `providers/model-catalog.ts` records why the index is the same authority
 *     and not a second one.
 *   · `probeCredentials` is an AsyncIterable rather than a `Promise<Map>` so the
 *     `done/total` counter advances as each probe settles; a single awaited map
 *     would hide ~30 probes behind one silent pause, one of which is a
 *     multi-second 1Password handshake.
 */

import { credentials } from "../auth/credentials/authority.js";
import { isSubscriptionProvider } from "../handlers/shared/remote-provider-types.js";
import {
  type ModelInfo,
  type PickerDiscoveryOutcome,
  buildDiscoveredModelOutcome,
  buildProviderChoices,
  providerShortcut,
  servedModelsForProvider,
} from "../model-selector.js";
import { isLocalProviderEnabled } from "../profile-config.js";
import { ensureCatalogReady } from "../providers/catalog-client.js";
import { createCatalogClient } from "../providers/model-catalog.js";
import { type DescriptionIndex, loadModelDescriptions } from "../providers/model-descriptions.js";
import { getAllProviders, getProviderByName } from "../providers/provider-definitions.js";

/** How a provider bills — the row's tag, and the reason a price may be absent. */
export type BillingMode = "sub" | "local" | "metered";

/**
 * Which in-flight indicator discovering one provider's models earns (§4.3), decided
 * synchronously from the provider's discovery format.
 *
 * `deadline` is the GET half, the only path that sees `FETCH_TIMEOUT_MS` — so an
 * elapsed-vs-deadline bar can be drawn and LABELLED as a deadline. `elapsed` is
 * the registered-fetcher half (ollama-tags, devin-connect, antigravity), where this
 * module owns no deadline at all: inventing 5 000 ms, or copying Ollama's 3 000 ms
 * onto Devin, would be a guess rendered as a fact. An elapsed counter with no
 * denominator makes exactly one claim — time is passing — and that claim is true.
 */
export type DiscoveryShape = "deadline" | "elapsed" | "none";

/** One provider, as every view of the picker needs it on frame one. */
export interface PickerProviderChoice {
  /** `ProviderDefinition.name` — the value every other call is keyed by. */
  value: string;
  /** The editorial display name — `Kimi / Moonshot`, `OpenAI Codex`. */
  label: string;
  /**
   * The routing shortcut this provider's rows print, `kc@` / `or@` / `gk@`.
   * DERIVED (`providerShortcut`), never a table, and it is the string the user
   * can retype on argv.
   */
  shortcut: string;
  description: string;
  billing: BillingMode;
  /** The env var to name in a credential notice. Empty for OAuth-only providers. */
  envVar: string;
  /** Does this provider list its own dynamic models catalog? Decides whether `p` runs discovery. */
  hasDiscovery: boolean;
  discoveryShape: DiscoveryShape;
}

export interface PickerDataSource {
  /** Sync, so frame one is never blank: derived from the provider definitions. */
  providerList(): PickerProviderChoice[];
  /** Built-in local providers present in the catalog but not enabled in config. */
  notEnabledLocalProviders(): string[];
  /** The provider's editorial display name, for dialog titles and notices. */
  displayName(provider: string): string;
  /** Readiness per provider, yielded AS EACH SETTLES — never one awaited map. */
  probeCredentials(names: string[]): AsyncIterable<[string, boolean]>;
  /** Make the cross-vendor catalog usable. Bounded, and never throws. */
  ensureCatalog(): Promise<void>;
  /** What this provider SERVES, from the local served-by index. Sync. */
  servedModels(provider: string): ModelInfo[];
  /** One settled outcome per discovery provider, `fallbackRows` included. */
  discoverModelsCatalog(provider: string): Promise<PickerDiscoveryOutcome>;
  /**
   * One editorial sentence per model, for the detail pane. Resolves late and is
   * never awaited before a first paint; the slim catalog carries no description.
   */
  descriptions(): Promise<DescriptionIndex>;
}

/** How a provider bills, from the two oracles that already answer it. */
export function billingModeOf(provider: string): BillingMode {
  if (isSubscriptionProvider(provider)) return "sub";
  return getProviderByName(provider)?.isLocal === true ? "local" : "metered";
}

/**
 * Which indicator shape a provider's discovery earns.
 *
 * `openai-models-list` is the one format that runs through the GET half, which is
 * the only place `FETCH_TIMEOUT_MS` is referenced. Everything else is a registered
 * fetcher with its own, unpublished deadline.
 */
export function discoveryShapeOf(provider: string): DiscoveryShape {
  const format = getProviderByName(provider)?.modelDiscovery?.format;
  if (!format) return "none";
  return format === "openai-models-list" ? "deadline" : "elapsed";
}

/** The deadline the `deadline` shape is drawn against. Mirrors `FETCH_TIMEOUT_MS`. */
export const DISCOVERY_DEADLINE_MS = 5000;

/**
 * How long the picker will wait for a cold catalog before drawing what it has.
 *
 * It is NOT rendered as a determinate bar, deliberately. `ensureCatalogReady`
 * races this timeout against `refreshCatalog(8000)` — two different numbers, so
 * there is no single denominator a bar could honestly be drawn against. The
 * catalog row gets a shimmer and an elapsed figure, which claims only that time
 * is passing.
 */
const CATALOG_WAIT_MS = 5000;

/**
 * Yield each promise's value as it settles, in COMPLETION order.
 *
 * `Promise.all` would hold every result until the slowest one lands, which is the
 * silent pause this whole design exists to remove: one 1Password handshake is
 * multi-second, and with `all` it would freeze ~30 rows that had already answered.
 *
 * A rejection is mapped by the caller, never here — a generator that throws
 * mid-iteration would abandon the probes that had not yet been drained.
 */
async function* inCompletionOrder<T>(promises: Array<Promise<T>>): AsyncGenerator<T> {
  const live = new Map(promises.map((p, i) => [i, p.then((v) => ({ i, v }))]));
  while (live.size > 0) {
    const { i, v } = await Promise.race(live.values());
    live.delete(i);
    yield v;
  }
}

/**
 * The production data source. Every method wraps an existing function verbatim —
 * no new fetch, no new field, no new plumbing.
 *
 * ONE `CatalogClient` PER PICKER OPEN, captured here rather than per call, so the
 * 24 h slim-cache read and the per-vendor memo are shared by every list the picker
 * renders. `selectModel` made the same choice for the same reason.
 */
export function createPickerDataSource(): PickerDataSource {
  const catalog = createCatalogClient();
  // Resolved once per open. `buildProviderChoices()` is pure and derived — never a
  // membership table (`routing.md:139`) — so calling it twice would be free but
  // would also let the dynamic models catalog and the notices disagree about ordering.
  const choices = buildProviderChoices().filter((c) => c.value !== "skip" && c.value !== "custom");
  const names = new Map(choices.map((c) => [c.value, c.name]));

  return {
    providerList(): PickerProviderChoice[] {
      return choices.map((c) => ({
        value: c.value,
        label: c.name,
        shortcut: providerShortcut(c.value),
        description: c.description,
        billing: billingModeOf(c.value),
        envVar: getProviderByName(c.value)?.apiKeyEnvVar ?? "",
        hasDiscovery: Boolean(getProviderByName(c.value)?.modelDiscovery),
        discoveryShape: discoveryShapeOf(c.value),
      }));
    },

    notEnabledLocalProviders(): string[] {
      // Derived, so `routing.md:139` holds: no membership list to keep current.
      // `isLocalProviderEnabled` is a pure config read — it never probes a daemon,
      // which is why a dead LM Studio is NOT what this row is about.
      return getAllProviders()
        .filter((d) => d.isLocal === true && !isLocalProviderEnabled(d.name))
        .map((d) => d.name);
    },

    displayName(provider: string): string {
      return names.get(provider) ?? provider;
    },

    probeCredentials(providers: string[]): AsyncIterable<[string, boolean]> {
      return inCompletionOrder(
        providers.map(
          async (name): Promise<[string, boolean]> => [
            name,
            // Documented never to throw (`authority.ts:110-117`), guarded anyway:
            // behind a live renderer an unhandled rejection has nowhere to surface.
            await credentials.isAvailable(name).catch(() => false),
          ]
        )
      );
    },

    async ensureCatalog(): Promise<void> {
      // Documented never to throw; guarded anyway, for the same reason as above.
      await ensureCatalogReady(CATALOG_WAIT_MS).catch(() => undefined);
    },

    servedModels(provider: string): ModelInfo[] {
      return servedModelsForProvider(provider, catalog);
    },

    discoverModelsCatalog(provider: string): Promise<PickerDiscoveryOutcome> {
      return buildDiscoveredModelOutcome(provider, names.get(provider) ?? provider, catalog);
    },

    descriptions(): Promise<DescriptionIndex> {
      return loadModelDescriptions();
    },
  };
}
