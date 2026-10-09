/**
 * The one place endpoints get registered, and the one place that decides when.
 *
 * Six call sites need the provider list to already contain the bundled
 * catalog — the interactive picker, `--probe`, the proxy, the parent-side
 * spawn pre-hydration, the config TUI and `serve` — and each of them reaches it
 * by a different path. A latch here means the answer does not depend on which
 * one ran first, and the config is read exactly once per process.
 *
 * ── Why this function is SYNCHRONOUS, and why that is the design ────────────
 *
 * Because nothing on this path can `await`, nothing on it can reach the
 * 1Password SDK — the SDK sits behind `await` inside the authority's async
 * `resolveKey`. THAT is the guarantee, and it is worth being exact about:
 * `op-source.ts` and `@1password/sdk` ARE in this module's static import
 * closure (via `predefined-endpoints` → `custom-endpoints-loader` →
 * `authority` → `api-key-credential`), so the protection is sync-ness, not
 * import-graph isolation, and a future edit could reach the SDK without
 * changing a single signature. It matters on a machine where concurrent
 * 1Password handshakes are arbitrated globally and a burst of denials trips a
 * 15-second machine-wide suppression. Registration reads `process.env`, the
 * config file and an array embedded in the binary. It opens no socket and
 * builds no handler: `buildProviderProfile` returns a closure, so nothing is
 * constructed until a request actually routes to one of these providers.
 *
 * Keep it sync. An `async` here would compile fine and quietly re-open that
 * door.
 *
 * ── Why there is an explicit re-evaluation entry point ─────────────────────
 *
 * The latch on its own breaks the config TUI's hydrate-on-add: importing a
 * 1Password key there hydrates `process.env`, drops handler caches and calls
 * `refreshConfig()` so providers light up WITHOUT a restart. A latched
 * registration would never re-ask, so a just-imported `GROQ_API_KEY` would
 * leave its vendor invisible until relaunch — reintroducing exactly the
 * before/after-hydration window that path exists to close. Hence
 * `{ force: true }` / `invalidateEndpointRegistration()`.
 *
 * Re-evaluation only ADDS: the runtime registry has no removal, so a row that
 * has since been disabled stays registered for the life of the process. That is
 * the right trade — the alternative is a de-registration path whose only
 * consumer is a config edit made mid-session, and a PARTIAL removal (definition
 * gone, credential registration and any cached handler still live) is worse
 * than a stale provider because it half-exists. The cost is paid in a warning
 * instead: `loadPredefinedEndpoints` names any row that was registered earlier
 * in this process and is no longer eligible, and says a restart is required.
 * Silence there was the actual defect — "I turned it off and it kept
 * answering" reads as a bug, not as a documented limit.
 *
 * ── SCOPE: both halves, and why they had to converge ───────────────────────
 *
 * This used to register the BUNDLED catalog only, with user-authored
 * `customEndpoints` loaded separately from `proxy-server.ts` and
 * `prehydrate.ts`. Both of those run AFTER the two surfaces that enumerate
 * providers — `--probe` (which `process.exit(0)`s in the `--probe` branch) and
 * the interactive picker — so a user who configured a custom endpoint could
 * not see it in the picker and could not probe it, even though it served real
 * requests correctly (#192).
 *
 * Folding them together also closes #191, because the reserved-namespace
 * refusal the catalog has always applied now covers user entries too.
 *
 * ORDER IS LOAD-BEARING: the bundled catalog registers FIRST, user endpoints
 * second. `loadPredefinedEndpoints` suppresses any bundled row whose name a
 * user entry also claims (R4, "the user's entry replaces the bundled one"), and
 * it decides that from `config.customEndpoints` rather than from write order.
 * Registering users first would instead trip its `runtime.has(name) &&
 * !ownRegistrations.has(name)` branch and print an "already registered" warning
 * for a row that is being correctly replaced.
 *
 * CONFIG SCOPE: `customEndpoints` is read from the GLOBAL config only, and that
 * is deliberate rather than an oversight. `loadConfig()` and `loadLocalConfig()`
 * are separate reads with no merge, and the catalog's suppression set must be
 * built from the SAME object the loader reads — otherwise a project-scoped
 * `customEndpoints.groq` suppresses the bundled row while its replacement,
 * read from global config, never registers, and the provider disappears
 * outright. A project `.claudish.json` that declares `customEndpoints` is
 * therefore ignored, and `warnOnProjectScopedEndpoints` says so out loud
 * instead of leaving the user to discover it.
 */

import { logStderr } from "../logger.js";
import { type ClaudishProfileConfig, loadConfig, loadLocalConfig } from "../profile-config.js";
import { type LoadResult, loadCustomEndpoints } from "./custom-endpoints-loader.js";
import { loadPredefinedEndpoints } from "./predefined-endpoints.js";

let registered = false;

/**
 * What the last `loadCustomEndpoints` run produced, for callers that want to
 * report it without re-running registration.
 *
 * `proxy-server.ts` logs "Registered N custom endpoint(s)", and it is almost
 * never the site that actually registers them — the picker or `--probe` got
 * there first and latched. Re-running the loader just to obtain a count would
 * re-register every endpoint for a log line.
 */
let lastCustomResult: LoadResult = { registered: 0, errors: [], refused: [] };

/** The result of the most recent custom-endpoint registration in this process. */
export function getCustomEndpointResult(): LoadResult {
  return lastCustomResult;
}

export interface EnsureEndpointsOptions {
  /** Re-evaluate even though registration already ran. */
  force?: boolean;
  /**
   * The GLOBAL config (`loadConfig()`) to decide against.
   *
   * Pass it at any site that also calls `loadCustomEndpoints`, so both halves
   * demonstrably read ONE object: the catalog's suppression set is built from
   * `customEndpoints`, and the two halves disagreeing about which config —
   * or which SCOPE — they read is what deletes a provider outright (a
   * project-scoped `customEndpoints.groq` suppressing the bundled row while its
   * replacement, read from global config, never registers). Must never be a
   * project `.claudish.json`: `customEndpoints` is global-only today, so a
   * wider scope here is precisely the mismatch to avoid.
   */
  config?: ClaudishProfileConfig;
}

/**
 * Register the bundled endpoint catalog and the user's own `customEndpoints`.
 * Idempotent; a no-op after the first call unless `force` is set.
 *
 * NEVER throws. A config that cannot be read leaves the user with the builtin
 * provider set — the same degradation every other config consumer applies —
 * rather than taking down whichever startup path happened to call first.
 */
export function ensureEndpointsRegistered(opts: EnsureEndpointsOptions = {}): void {
  if (registered && !opts.force) return;

  let config: ClaudishProfileConfig;
  try {
    config = opts.config ?? loadConfig();
  } catch {
    // The LATCH IS NOT SET on this path, deliberately. Latching first and
    // returning here would burn the one registration this process gets on a
    // read that produced nothing: every later call — including one passing an
    // explicit config — would short-circuit, and the user would run with the
    // builtin set only, permanently, from a transient failure.
    //
    // Not latching means a later call retries the read. The cost is one extra
    // `loadConfig()` in a case that is already failing; the benefit is that a
    // caller holding a good config can still rescue the process.
    //
    // Deliberately silent otherwise: every other consumer of the same file
    // already reports an unreadable config.
    return;
  }

  // Latch only once there is something to register FROM. Set before the work
  // rather than after, so a throw inside registration cannot spin a caller that
  // retries; the per-half catches below already contain those.
  registered = true;

  // ── Each half gets its OWN try, and that is the point ──────────────────────
  //
  // These used to be two separate call sites with two separate catches
  // (`ensureEndpointsRegistered` here, `loadCustomEndpoints` in
  // `proxy-server.ts`). Merging them under one `try` would have quietly coupled
  // them: a throw anywhere in the bundled catalog would skip the user's own
  // endpoints entirely, so a bad row in a vendor list claudish ships could
  // delete a provider the user configured by hand. That is a strictly worse
  // failure than the one being fixed, and it would be invisible.
  //
  // Bundled first, user second. See ORDER IS LOAD-BEARING above.
  try {
    loadPredefinedEndpoints(config);
  } catch {
    // `loadPredefinedEndpoints` already warns per row for anything it can
    // attribute; a failure past that point is not attributable to a vendor.
  }

  try {
    lastCustomResult = loadCustomEndpoints(config);
    reportCustomEndpoints(lastCustomResult);
  } catch {
    // `loadCustomEndpoints` collects per-entry failures rather than throwing,
    // so reaching here means something structural. The builtin provider set
    // still works, which is the same degradation every other config consumer
    // applies.
  }

  try {
    warnOnProjectScopedEndpoints();
  } catch {
    // A diagnostic must never be able to break registration.
  }
}

/**
 * Say what `loadCustomEndpoints` refused, once per distinct message.
 *
 * `loadCustomEndpoints` returns rather than prints, because it is also called
 * from the config TUI where stderr is the user's own screen. This is the CLI
 * reporting site, so the wording can be blunt.
 *
 * A refusal is louder than a validation error on purpose. An invalid entry
 * already fails visibly; a refused one is well-formed JSON that claudish is
 * declining to honour, and the user has no other way to learn that.
 */
function reportCustomEndpoints(result: ReturnType<typeof loadCustomEndpoints>): void {
  // Validation errors go through `logStderr`, which is what `proxy-server.ts`
  // used before this moved. That is not incidental: `logStderr` honours
  // `--quiet`, routes to the diag log when one is open, and ALWAYS writes to the
  // debug log. Swapping it for `console.error` would have made a malformed entry
  // print into a stderr that, during an interactive session, is Claude Code's
  // own TTY — the terminal-corruption path this codebase has already paid for
  // once. Same message, same conditions, same destination as before.
  for (const { name, message } of result.errors) {
    logStderr(`customEndpoints['${name}'] failed validation: ${message}`);
  }
  // A refusal also goes through `logStderr`, and NOT through raw `console.error`.
  //
  // The tempting argument is that a refusal should be unconditional because
  // silence is the actual bug in #191. It loses to a concrete one: `App.tsx`'s
  // `refreshConfig` calls `ensureEndpointsRegistered({ force: true })` from
  // INSIDE the fullscreen config TUI, on every config save and every 1Password
  // key import. `tui/index.tsx` calls `setStderrQuiet(true)` on mount for
  // exactly this reason — "writing them to stderr would corrupt the OpenTUI
  // buffer and leave ghost characters on screen (the renderer can't invalidate
  // cells it didn't draw)" — and `logStderr` honours that flag while
  // `console.error` walks straight past it.
  //
  // Nothing is lost by deferring to it. `logStderr` ALWAYS writes to the debug
  // log, and `loadCustomEndpoints` has already called `recordEndpointUnavailable`
  // for this name, so the reason resurfaces verbatim the moment anyone actually
  // tries to route to that provider. The security property — the builtin's
  // credential is not replaced — holds whether or not the line prints.
  //
  // `warnOnce` still wraps it, because `force: true` re-runs this on every save
  // and an un-deduplicated warning would become a wall.
  for (const { name, reason } of result.refused) {
    warnOnce(
      `customEndpoints['${name}'] skipped: ${reason}. The builtin wins. ` +
        `Rename your entry (e.g. '${name}-custom') to use it.`
    );
  }
}

/**
 * Warn when a project `.claudish.json` declares `customEndpoints`.
 *
 * They are not read — see CONFIG SCOPE above — and before this the failure was
 * total silence: the endpoint simply never existed, with no error, no warning
 * and nothing in `--probe` to suggest the file had even been looked at.
 *
 * Deliberately a warning rather than support. Merging project scope in means
 * the catalog's suppression set and the endpoint loader must provably read one
 * object, and getting that wrong deletes a provider outright rather than
 * failing loudly. That is a change worth making on its own, with its own tests,
 * not a rider on this one.
 *
 * Never throws: a project config that cannot be read is not this function's
 * problem, and every other consumer of that file already reports it.
 */
function warnOnProjectScopedEndpoints(): void {
  try {
    const local = loadLocalConfig() as { customEndpoints?: Record<string, unknown> } | undefined;
    const names = Object.keys(local?.customEndpoints ?? {});
    if (names.length === 0) return;
    warnOnce(
      `.claudish.json declares customEndpoints (${names.join(", ")}) but they are ` +
        "read from the GLOBAL config only, so they are being ignored. Move them to " +
        "~/.claudish/config.json."
    );
  } catch {
    // No project config, or unreadable. Either way there is nothing to warn about.
  }
}

// Warn-once, same shape and rationale as `predefined-endpoints.ts`'s: this
// function is reachable from seven call sites and re-runnable with `force`, so
// an un-deduplicated warning becomes a wall. Keyed on the rendered message, so
// two different collisions still both print.
//
// Routes through `logStderr` rather than `console.error`, unlike its sibling in
// `predefined-endpoints.ts`. `refreshConfig` in the config TUI re-runs
// registration with `force: true` while OpenTUI owns the screen, and a raw
// stderr write there leaves ghost cells the renderer cannot invalidate.
// `logStderr` respects the `setStderrQuiet(true)` the TUI sets on mount and
// still writes every message to the debug log.
const warnedMessages = new Set<string>();

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  logStderr(message);
}

/**
 * Forget the latch so the next `ensureEndpointsRegistered()` re-evaluates.
 * Call after anything that can change the answer within a live process —
 * a credential imported in the config TUI, a config save.
 */
export function invalidateEndpointRegistration(): void {
  registered = false;
}
