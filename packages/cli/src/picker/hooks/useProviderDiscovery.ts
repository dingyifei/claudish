/**
 * useProviderDiscovery — one settled outcome per discovery provider, and the elapsed
 * clock the in-flight indicator is drawn from.
 *
 * NO REJECTION BRANCH, BY CONTRACT. `discoverProviderModelsCatalog` never rejects — every
 * throw inside it is mapped to `failed{kind:"unreachable"}` — and
 * `buildDiscoveredModelOutcome` inherits that guarantee through `Promise.allSettled`.
 * That contract is what lets this hook be small; it is also pinned by a unit test
 * with a fetcher registered to throw, because a contract is not a type. The `catch`
 * below exists anyway, for the one failure a contract cannot cover: a data source
 * that is not the production one.
 *
 * THE ELAPSED CLOCK IS NOT STATE. `startedAt` is recorded once per request and the
 * view re-renders from `useAnimationFrame`'s 100 ms tick, computing
 * `Date.now() - startedAt` at render time. Storing elapsed milliseconds in state
 * would be a `setState` per tick for a number nothing else reads.
 *
 * EVERY FAILURE IS REPORTED, NOT JUST THE LAST. `onFailure` fires once per provider
 * whose outcome lands `failed`, in the order they occurred, because that is what the
 * behaviour being preserved does: today each failed selection writes its diagnostic
 * to stderr immediately, so a session that tried two failing providers leaves two
 * lines in the scrollback. Writing one after teardown would be a quiet narrowing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelInfo, PickerDiscoveryOutcome } from "../../model-selector.js";
import type { PickerDataSource } from "../PickerDataSource.js";

export interface DiscoveryState {
  /** The selected provider's outcome, or `null` while it is in flight. */
  outcome: PickerDiscoveryOutcome | null;
  /** True while a request for the selected provider is open. */
  busy: boolean;
  /** `Date.now()` when the open request started, for the elapsed figure. */
  startedAt: number | null;
  /** Every outcome seen this session, so a revisit costs nothing. */
  seen: ReadonlyMap<string, PickerDiscoveryOutcome>;
  /**
   * Discard this provider's settled outcome and ask again.
   *
   * A DISCOVERY FAILURE IS OFTEN TRANSIENT AND THE PREVIOUS BUILD HAD NO WAY BACK.
   * A timeout, a laptop that just came off a captive portal, a key pasted into
   * another shell — every one of those is fixed by asking a second time, and the
   * only recourse the picker offered was to quit it and start again, which throws
   * away the whole credential sweep. `r` is the answer.
   *
   * It clears the memo as well as the outcome, deliberately: the memo exists so
   * that ARROWING back to a provider costs nothing, and a retry is the one moment
   * where "you already asked" is the wrong answer.
   */
  retry: (provider: string) => void;
}

export function useProviderDiscovery(
  source: PickerDataSource,
  provider: string | null,
  /** False unless this provider declares `modelDiscovery`. */
  wanted: boolean,
  /** Called once per provider that lands `failed`, for the post-teardown write. */
  onFailure?: (provider: string, notice: readonly string[]) => void
): DiscoveryState {
  const [outcomes, setOutcomes] = useState<Map<string, PickerDiscoveryOutcome>>(new Map());
  const [started, setStarted] = useState<Record<string, number>>({});
  const inflight = useRef(new Map<string, Promise<PickerDiscoveryOutcome>>());
  // A ref, not state: the callback identity must not re-trigger the effect, and a
  // stale closure here would report a failure to a buffer nobody drains.
  const report = useRef(onFailure);
  report.current = onFailure;
  const reported = useRef(new Set<string>());

  const load = useCallback(
    (name: string): void => {
      const cache = inflight.current;
      if (cache.has(name)) return;
      const request = source.discoverModelsCatalog(name);
      cache.set(name, request);
      setStarted((prev) => (prev[name] === undefined ? { ...prev, [name]: Date.now() } : prev));
      void request.then(
        (outcome) => {
          setOutcomes((prev) => new Map(prev).set(name, outcome));
          if (outcome.kind === "failed" && !reported.current.has(name)) {
            reported.current.add(name);
            report.current?.(name, outcome.notice);
          }
        },
        (err: unknown) => {
          cache.delete(name);
          setOutcomes((prev) =>
            new Map(prev).set(name, {
              kind: "failed",
              failure: { kind: "unreachable", provider: name, detail: String(err) },
              notice: [`${name} could not list its models: ${String(err)}`],
              fallbackRows: [],
            })
          );
        }
      );
    },
    [source]
  );

  const retry = useCallback(
    (name: string): void => {
      inflight.current.delete(name);
      reported.current.delete(name);
      setOutcomes((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
      // The elapsed clock restarts HERE rather than inside `load`, whose own
      // `setStarted` is deliberately write-once so an arrow-key revisit does not
      // reset a running counter. A retry is a new request and gets a new clock.
      setStarted((prev) => ({ ...prev, [name]: Date.now() }));
      load(name);
    },
    [load]
  );

  useEffect(() => {
    if (provider === null || !wanted) return;
    load(provider);
  }, [provider, wanted, load]);

  const outcome = provider !== null && wanted ? (outcomes.get(provider) ?? null) : null;
  const busy = provider !== null && wanted && outcome === null;
  return {
    outcome,
    busy,
    retry,
    startedAt: busy && provider !== null ? (started[provider] ?? null) : null,
    seen: outcomes,
  };
}

/**
 * The dynamic models catalogs ALREADY IN HAND, as the cross-provider list wants them.
 *
 * THIS IS WHAT REPLACED THE STARTUP FAN-OUT. An earlier build fired one dynamic models catalog
 * request per credentialled provider the moment the picker opened — thirteen
 * requests, a `0/11 providers` discovery meter, and the owner's verdict was
 * *"why we prefetching? we should not, as we show on demand"*. Every one of those
 * requests is now made for a provider the user actually opened, by the hook above.
 * This function spends no network at all: it re-reads the outcomes that are
 * already settled, so a provider he visited enriches the all-models view for free
 * and a provider he did not visit is simply not represented there.
 *
 * ONLY `rows`. A failure's `fallbackRows` are the catalog's, which the flat list
 * already holds under the same provider — merging them would double that
 * provider's rows and launder a fallback into a dynamic models catalog at the same time.
 */
export function rowsFromOutcomes(
  seen: ReadonlyMap<string, PickerDiscoveryOutcome>
): Map<string, ModelInfo[]> {
  const out = new Map<string, ModelInfo[]>();
  for (const [provider, outcome] of seen) {
    if (outcome.kind === "rows") out.set(provider, outcome.rows);
  }
  return out;
}
