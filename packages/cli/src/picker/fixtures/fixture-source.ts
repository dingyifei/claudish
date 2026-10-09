/**
 * picker/fixtures/fixture-source.ts — a scriptable `PickerDataSource`, for the states
 * a live provider cannot be made to produce.
 *
 * DEV-ONLY. It is reached exclusively through a dynamic `await import()` behind the
 * `CLAUDISH_PICKER_FIXTURE` check in `model-picker-run.tsx`, so `bun build --compile`
 * never walks into this directory and the shipped binary carries no fixture data.
 *
 * IT WRAPS THE PRODUCTION SOURCE AND OVERRIDES ONLY THE SHAPE OF AN ANSWER — never
 * the data. The provider list is still derived from the provider definitions, every model row
 * is still the real catalog's, every price and context window is still whatever the
 * backend says. What a scenario forges is the OUTCOME VARIANT (an empty dynamic models catalog, a
 * timeout, a dynamic models catalog where nothing is chat-capable), the readiness answers, and
 * latency. That keeps the "never hardcode a provider's models, context windows or pricing" rule
 * intact inside a capture harness, which matters because a screenshot of invented
 * prices proves nothing about the layout of real ones.
 *
 * WHY A FAKE AT ALL — the four states below are the whole point of the feature and
 * none of them is reachable from outside:
 *
 *   · `loading`  the credential sweep held mid-`done/total` — the landing screen's
 *                only in-flight state, and on a real machine it is over in a second.
 *   · `discovering` credentials settle normally and the DYNAMIC MODELS CATALOG never comes back.
 *                This is the per-provider wait, which exists only because a dynamic models catalog
 *                is now fetched when the user OPENS that provider.
 *   · `empty`    a provider that answers correctly with nothing chat-capable.
 *   · `filtered` a provider that serves only embeddings or wildcard routes.
 *   · `timeout`  an unreachable endpoint, on demand.
 *
 * V5 (unauthorized) is deliberately NOT the primary use: it is reproducible live with
 * a bogus key against the real endpoint, which is how the "before" frame was measured,
 * and a live capture beats a forged one every time. The scenario exists as a control.
 */

import type { ModelInfo, PickerDiscoveryOutcome } from "../../model-selector.js";
import type { DescriptionIndex } from "../../providers/model-descriptions.js";
import {
  type PickerDataSource,
  type PickerProviderChoice,
  createPickerDataSource,
} from "../PickerDataSource.js";

export type FixtureName =
  | "ready"
  | "loading"
  | "discovering"
  | "timeout"
  | "empty"
  | "filtered"
  | "unauthorized";

const NEVER = new Promise<never>(() => {
  /* deliberately never settles — a capture window is finite, this is not */
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Scenarios that forge a discovery OUTCOME also claim discovery for every provider,
 * so the state is on screen wherever the cursor happens to be scoped. Without that, a
 * capture would have to drive keystrokes to a particular provider and would break the
 * moment the picker order changed.
 */
const FORCED_OUTCOME = new Set<FixtureName>(["timeout", "empty", "filtered", "unauthorized"]);

export function createFixtureDataSource(name: string): PickerDataSource {
  const scenario = (name as FixtureName) ?? "ready";
  const real = createPickerDataSource();
  const forced = FORCED_OUTCOME.has(scenario);
  // `loading` claims discovery too — not to forge an outcome (it has none; it never
  // settles) but so that a scoped provider exercises the DYNAMIC MODELS CATALOG indicator, whose
  // deadline shape is otherwise unreachable in a capture.
  const claimsDiscovery = forced || scenario === "loading" || scenario === "discovering";

  return {
    providerList(): PickerProviderChoice[] {
      return real
        .providerList()
        .map((r) =>
          claimsDiscovery ? { ...r, hasDiscovery: true, discoveryShape: "deadline" as const } : r
        );
    },

    notEnabledLocalProviders: () => real.notEnabledLocalProviders(),
    displayName: (p) => real.displayName(p),

    async *probeCredentials(names: string[]): AsyncIterable<[string, boolean]> {
      // EVERY PROVIDER READY, and that is a forgery with a purpose: a capture runs with
      // credential sources disabled so it cannot raise a 1Password or Keychain prompt on
      // the user's desktop, which leaves the real provider list three rows long and says nothing
      // about how the list looks for a configured user.
      for (const n of names) {
        if (scenario === "loading") await sleep(600);
        yield [n, true];
      }
      if (scenario === "loading") await NEVER; // hold the `done/total` meter mid-sweep
    },

    ensureCatalog(): Promise<void> {
      return scenario === "loading" ? NEVER : real.ensureCatalog();
    },

    servedModels(provider: string): ModelInfo[] {
      return real.servedModels(provider);
    },

    descriptions(): Promise<DescriptionIndex> {
      // NOT forged: a description is editorial text from the real catalog, and a
      // capture of an invented sentence proves nothing about how a real one wraps.
      return scenario === "loading" ? NEVER : real.descriptions();
    },

    async discoverModelsCatalog(provider: string): Promise<PickerDiscoveryOutcome> {
      // `discovering` is the whole point of that scenario: the credential sweep
      // finishes, the provider list is on screen and usable, and the dynamic models catalog the
      // user just asked for never lands. It is the only way to photograph the
      // per-provider wait, which against a real provider is over in a second.
      if (scenario === "loading" || scenario === "discovering") return NEVER;
      if (!forced) return real.discoverModelsCatalog(provider);

      // The fallback list is the REAL vendor catalog for this provider, because the
      // defect being rendered is precisely that an unmarked fallback list reads as a
      // healthy short dynamic models catalog — and that only shows on real rows.
      const fallbackRows = real.servedModels(provider);
      const displayName = real.displayName(provider);

      if (scenario === "empty") {
        return {
          kind: "empty-models-catalog",
          failure: {
            kind: "empty-models-catalog",
            provider,
            endpoint: "https://api.example.test/v1/models",
          },
          fallbackRows,
        };
      }
      if (scenario === "filtered") {
        return {
          kind: "all-filtered",
          servedCount: 7,
          sampleIds: ["text-embedding-3-large", "whisper-1", "tts-1-hd"],
          fallbackRows,
        };
      }
      if (scenario === "timeout") {
        return {
          kind: "failed",
          failure: {
            kind: "unreachable",
            provider,
            endpoint: "https://api.example.test/v1/models",
            detail: "The operation was aborted due to timeout",
          },
          notice: [
            `\n⚠ ${displayName} could not list its models: the model list was unreachable at https://api.example.test/v1/models — The operation was aborted due to timeout\n`,
            fallbackRows.length > 0
              ? `  Showing ${displayName}'s cloud-catalog entries below — not its live model list.\n\n`
              : "  Falling back to manual model entry.\n\n",
          ],
          fallbackRows,
        };
      }
      return {
        kind: "failed",
        failure: {
          kind: "unauthorized",
          provider,
          status: 401,
          endpoint: "https://api.example.test/v1/models",
          detail:
            '{"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}',
        },
        notice: [
          `\n⚠ ${displayName} could not list its models: the API key was rejected (HTTP 401) at https://api.example.test/v1/models\n`,
          "  Check EXAMPLE_API_KEY (a value in your shell overrides stored credentials).\n",
          "  Get a key: https://platform.example.test/keys\n",
          fallbackRows.length > 0
            ? `  Showing ${displayName}'s cloud-catalog entries below — not its live model list.\n\n`
            : "  Falling back to manual model entry.\n\n",
        ],
        fallbackRows,
      };
    },
  };
}
