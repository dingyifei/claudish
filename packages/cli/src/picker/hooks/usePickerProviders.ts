/**
 * usePickerProviders — the provider list, and the credential probe that fills it
 * in.
 *
 * `done/total` FROM THIS HOOK IS THE ONE DETERMINATE BAR IN THE PICKER, and it
 * earns the bar because both numbers are real: the provider list is derived
 * synchronously from the provider definitions, so `total` is known before the
 * first probe starts, and `done` is work actually completed. Nothing else the
 * picker waits on has a denominator, and nothing else gets a meter.
 *
 * `probeCredentials` is an AsyncIterable rather than one awaited map for the same
 * reason: each of ~31 `credentials.isAvailable` calls may read env, config, an
 * OAuth file, the macOS Keychain and the 1Password SDK, and a single awaited map
 * would hold every answer hostage to the slowest handshake.
 *
 * MEMBERSHIP IN THE STEADY STATE IS IDENTICAL TO TODAY'S. The old picker filtered
 * unready providers out entirely (`getProviderChoices`), which made the first
 * frame wait for every probe. This mounts the UNFILTERED provider list: a provider with
 * no credential contributes no MODEL rows (they would fail later at
 * `validateApiKeysForModels`, after the picker has closed) but it keeps its place
 * in the `p` dialog, with the env var it wants — so the absence is EXPLAINED
 * rather than silent, which is the principle the rest of the feature is built on.
 *
 * ONE FAN-OUT PER MOUNT, never per render: `selectModel` hoisted this call for
 * exactly that reason (its comment at `model-selector.ts:660-668`), and the profile
 * wizard's four-times-over probe is the counter-example this must not become.
 */

import { useEffect, useMemo, useState } from "react";
import type { PickerDataSource, PickerProviderChoice } from "../PickerDataSource.js";
import type { Readiness } from "../rows.js";

export interface ProviderState extends PickerProviderChoice {
  readiness: Readiness;
}

export interface PickerProvidersState {
  /** The provider list as handed over — stable identity, for downstream memos. */
  providerList: PickerProviderChoice[];
  /** Every pickable provider, in picker order, readiness included. */
  rows: ProviderState[];
  /** Ready providers — the ones that contribute model rows. */
  ready: ProviderState[];
  /** The same set, by name, for the flat list's membership test. */
  readySet: ReadonlySet<string>;
  /** Settled-but-unready providers, collapsed behind one summary row. */
  missing: ProviderState[];
  /** Probes settled so far. */
  done: number;
  /** Probes in total — known synchronously, which is what makes this real progress. */
  total: number;
  /** True until the last probe settles. */
  probing: boolean;
  /** Built-in local providers not enabled in config (§3.9) — a hint, not a row. */
  notEnabledLocal: string[];
}

export function usePickerProviders(source: PickerDataSource): PickerProvidersState {
  // The provider list is resolved ONCE. `providerList()` is pure and derived, so calling
  // it per render would be correct and still wrong: the rows would be new objects
  // every frame and every memo downstream would miss.
  const providerList = useMemo(() => source.providerList(), [source]);
  const notEnabledLocal = useMemo(() => source.notEnabledLocalProviders(), [source]);
  const [readiness, setReadiness] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let live = true;
    void (async () => {
      for await (const [name, ok] of source.probeCredentials(providerList.map((r) => r.value))) {
        if (!live) return;
        // One `setState` per settled probe, deliberately: ~30 of them over a second
        // or two is nowhere near the frame rate at which the mutable-store-plus-poll
        // pattern becomes necessary, and a batched update would lose the incremental
        // fill that is the whole affordance.
        setReadiness((prev) => ({ ...prev, [name]: ok }));
      }
    })();
    return () => {
      // The probes are abandoned, not awaited. Nothing writes to a destroyed
      // renderer because React is unmounted before the renderer is destroyed, and
      // `isAvailable` has no side effect worth draining.
      live = false;
    };
  }, [source, providerList]);

  const rows: ProviderState[] = providerList.map((r) => {
    const settled = readiness[r.value];
    return { ...r, readiness: settled === undefined ? "pending" : settled ? "ready" : "missing" };
  });
  const done = Object.keys(readiness).length;

  const readyRows = rows.filter((r) => r.readiness === "ready");

  return {
    providerList,
    rows,
    ready: readyRows,
    readySet: new Set(readyRows.map((r) => r.value)),
    missing: rows.filter((r) => r.readiness === "missing"),
    done,
    total: providerList.length,
    probing: done < providerList.length,
    notEnabledLocal,
  };
}
