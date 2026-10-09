/**
 * The two recovery switches, and the ONE place the tier-1 deadline is derived.
 *
 * Precedence for both switches, identical to the shape `cli.ts` already
 * implements for `debug`:
 *
 *   CLI flag  >  environment  >  project `.claudish.json`  >  global config  >  true
 *
 * `{}` at any scope means "no opinion" and falls through to the next one —
 * which is why both fields are objects rather than bare booleans.
 */

import { ENV } from "../config.js";
import { log } from "../logger.js";
import { readRecoveryEnabled, readRecoveryUi } from "../profile-config.js";

/** Flag layer. Set once by `cli.ts`'s arg loop; undefined means "not given". */
interface RecoveryFlagOverrides {
  recovery?: boolean;
  recoveryUi?: boolean;
}

let flagOverrides: RecoveryFlagOverrides = {};

/** Called by `cli.ts` when `--recovery` / `--no-recovery[-ui]` is parsed. */
export function setRecoveryFlagOverrides(overrides: RecoveryFlagOverrides): void {
  flagOverrides = { ...flagOverrides, ...overrides };
}

/** Tests and long-lived hosts (`serve`) that must not inherit a stale flag. */
export function resetRecoveryFlagOverrides(): void {
  flagOverrides = {};
}

/** `1`/`true` → true, `0`/`false` → false, anything else → undefined. */
function parseEnvBool(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return undefined;
}

/**
 * Is the retry ladder allowed to run at all? Default true.
 *
 * The one row of the status table that reads this answers today's immediate
 * 400 — so turning it off restores pre-recovery behaviour exactly, which is
 * what makes it a safe CI switch rather than a feature toggle.
 */
export function resolveRecoveryEnabled(): boolean {
  if (flagOverrides.recovery !== undefined) return flagOverrides.recovery;
  const env = parseEnvBool(process.env[ENV.CLAUDISH_RECOVERY]);
  if (env !== undefined) return env;
  const scoped = readRecoveryEnabled();
  if (scoped !== undefined) return scoped;
  return true;
}

/**
 * May claudish own a surface on which a recovery episode's reason is legible?
 * Default true.
 *
 * READ BY `claude-runner.ts`, which decides whether to wrap the session in a
 * magmux pane. It is the USER'S half of the gate; the other half is
 * `uiLeaseValid()`, which asks whether a renderer is painting THIS episode right
 * now. Both must hold before an exhausted episode may answer a retryable 503 —
 * the user has to have allowed a surface, and a surface has to actually exist.
 *
 * It was landed one phase before its first reader, deliberately, because of the
 * CLAUDE.md invariant it trips: a new `ClaudishProfileConfig` field that is not
 * in `loadConfig`'s allowlist AND has no scoped reader survives on disk until
 * the first global save and is then dropped, silently. That trap has caught this
 * codebase twice, so the field got its round-trip test the moment it was
 * defined rather than the moment it was first consumed.
 *
 * It is a question about the USER'S CONFIGURATION and about nothing else. It
 * must never be conflated with "can this process open a pane right now", which
 * is a launch-order fact that is false in every unwrapped launch, in `-p`, in
 * `serve` and in the whole test suite.
 */
export function resolveRecoveryUi(): boolean {
  if (flagOverrides.recoveryUi !== undefined) return flagOverrides.recoveryUi;
  const env = parseEnvBool(process.env[ENV.CLAUDISH_RECOVERY_UI]);
  if (env !== undefined) return env;
  const scoped = readRecoveryUi();
  if (scoped !== undefined) return scoped;
  return true;
}

/**
 * May this launch pay for a recovery surface — the magmux wrap, the UI
 * installation, and the client's amplified retry budget?
 *
 * BOTH switches, and `resolveRecoveryUi()` alone is NOT the answer. That is not
 * a style preference; it shipped as `resolveRecoveryUi()` alone at
 * `claude-runner.ts`'s wrap ternary and at its ambient branch, and the
 * consequence was measured on a real launch: `--no-recovery` left the session
 * wrapped in `magmux --id claudish-<pid>`.
 *
 * What that cost a user who had explicitly switched the feature OFF:
 *
 *   - magmux's scrollback ring REPLACES the emulator's own, which
 *     `network-recovery.md` calls the single most user-visible cost of
 *     wrapping by default (RISK-4);
 *   - +89 ms median at launch (11 paired samples, identical child both arms);
 *   - a generated launcher script on disk, and a login shell between claudish
 *     and Claude Code (RISK-5's whole surface).
 *
 * And it bought NOTHING, by construction rather than by luck: with the ladder
 * disabled `shouldSkipTier1` returns `recovery-disabled` on the first
 * classified failure, so no episode is ever opened, so `ensureRecoveryUi` is
 * never called and the pane can never appear. A wrap whose only consumer can
 * never run is pure cost.
 *
 * It also made RISK-7's mitigation false in the permissive direction —
 * `--no-recovery` is documented as restoring pre-recovery behaviour "byte for
 * byte", which was true of the RESPONSE and false of the LAUNCH.
 *
 * `retryWatchdogEnv` asked both switches from the start; these two sites did
 * not. One predicate now, read by all three, so they cannot drift again.
 */
export function recoverySurfaceAllowed(): boolean {
  return resolveRecoveryEnabled() && resolveRecoveryUi();
}

// ─── The deadline ────────────────────────────────────────────────────────────

/**
 * Claude Code's own default per-request timeout, MEASURED — not assumed.
 *
 * Six replications at 359.4 / 360.1 / 360.1 / 360.1 / 360.1 / 360.1 s against a
 * custom base URL, and it was then PROVED to be this variable rather than a
 * fixed watchdog by setting `API_TIMEOUT_MS=20000` and observing six aborts at
 * exactly 20.000 s.
 */
export const DEFAULT_API_TIMEOUT_MS = 360_000;

/**
 * We never derive a hold longer than this from the environment, however
 * generous `API_TIMEOUT_MS` is. It stops the constant from tracking one Claude
 * Code version's undocumented default, and it keeps the hold inside the range
 * where the other ceilings in this system (Bun's `idleTimeout`, lifted per
 * request but only on the recovery path) were reasoned about.
 */
export const CLIENT_CEILING_CLAMP_MS = 300_000;

/**
 * Reserve subtracted from the client's ceiling: the unclamped first attempt's
 * tail, the response write, and the gap between the client starting its clock
 * and our handler starting ours. Losing this race means the client aborts a
 * request we were about to answer, so the margin is deliberately generous.
 */
export const DEADLINE_MARGIN_MS = 30_000;

/**
 * Below this much budget, recovery is not worth attempting — but we clamp UP to
 * it rather than disabling, because a client that aborts is handled correctly
 * (the waiter leaves within a millisecond of `c.req.raw.signal` firing) whereas
 * a silently-skipped ladder is the failure this floor exists to make visible.
 *
 * WHY 15 s specifically, rather than a round number. The ladder's first rung is
 * 5 s and no attempt is started with less than `MIN_ATTEMPT_SLOT_MS` (3 s) of
 * budget left, so the smallest deadline that buys even ONE retry beyond the
 * unchanged first attempt is 5 + 3 = 8 s. 15 s buys that retry with room for
 * the attempt itself to take a few seconds, and stops one rung short of the
 * second (5 + 10 + 3 = 18 s). Anything under 8 s would make the ladder a pure
 * delay in front of the same 400 — machinery that runs, logs and recovers
 * nothing, which is worse than not running.
 */
export const TIER1_DEADLINE_FLOOR_MS = 15_000;

/**
 * The tier-1 hold, DERIVED from the environment on every request.
 *
 *   max(FLOOR, min(API_TIMEOUT_MS ?? 360_000, 300_000) − 30_000)
 *
 * At the default this is 270 000 ms. It is not hardcoded, and that is the point:
 * `API_TIMEOUT_MS` is a user-settable knob that sets the client's ceiling
 * exactly, so a machine with `API_TIMEOUT_MS=60000` running against a hardcoded
 * 270 s hold would end EVERY episode in `client_gone` — the feature doing
 * nothing at all, silently, forever, with nothing printed anywhere.
 *
 * A 270 s hold is not racing an impatient client. Claude Code's retry budget
 * was measured to be a COUNT (~11 attempts), not a duration: on the hung-upstream
 * path it was still retrying after 40 minutes and six full 360 s attempts. One
 * tier-1 hold spends well under one of those attempts.
 */
export function resolveTier1DeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV.API_TIMEOUT_MS];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  const clientCeiling =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, CLIENT_CEILING_CLAMP_MS)
      : CLIENT_CEILING_CLAMP_MS;
  const derived = clientCeiling - DEADLINE_MARGIN_MS;
  return Math.max(TIER1_DEADLINE_FLOOR_MS, derived);
}

/** The value `resolveTier1DeadlineMs` returns with nothing set. */
export const DEFAULT_TIER1_DEADLINE_MS = CLIENT_CEILING_CLAMP_MS - DEADLINE_MARGIN_MS;

let deadlineNoticeLogged = false;

/**
 * Announce a deadline the environment shortened, ONCE per process.
 *
 * A shortened budget is not an error and must not read as one, but it must not
 * be mysterious either: the whole point of deriving the number is that the user
 * can see it. Emitted from inside the recovery path, so a healthy run prints
 * nothing.
 */
export function logDeadlineIfShortened(deadlineMs: number): void {
  if (deadlineNoticeLogged) return;
  if (deadlineMs >= DEFAULT_TIER1_DEADLINE_MS) return;
  deadlineNoticeLogged = true;
  const raw = process.env[ENV.API_TIMEOUT_MS];
  log(
    `[Recovery] tier-1 hold shortened to ${Math.round(deadlineMs / 1000)}s ` +
      `(API_TIMEOUT_MS=${raw ?? "unset"}; default would be ${Math.round(DEFAULT_TIER1_DEADLINE_MS / 1000)}s)`
  );
}

/** Tests only — the notice latch is process state. */
export function resetDeadlineNotice(): void {
  deadlineNoticeLogged = false;
}

// ─── The client's retry budget ───────────────────────────────────────────────

/**
 * The environment that decides how far recovery REACHES, handed to the Claude
 * Code child.
 *
 * Tier 1 holds one inbound request for the derived deadline (~270 s at the
 * default) and then answers a retryable 503, which the client re-POSTs into the
 * SAME episode. So the outer bound on recovery is not ours at all — it is
 * Claude Code's willingness to keep asking, and `CLAUDE_CODE_RETRY_WATCHDOG`
 * is the variable that sets it.
 *
 * ── WHAT IT COSTS, STATED PLAINLY ───────────────────────────────────────────
 *
 * |                            | unset    | set (what ships) |
 * |----------------------------|----------|------------------|
 * | client retry budget        | ~11      | **~300**         |
 * | unattended reach           | ~66 min  | **~a day**       |
 * | worst-case attempts / turn | ~46      | **~2,100**       |
 * | duplicate-charge exposure  | accepted | **~30× that**    |
 *
 * The duplicate-charge exposure is real and is the reason this is worth a
 * paragraph rather than a line: a request the provider ACCEPTED and began
 * billing can still fail on `ECONNRESET`/`EPIPE`, and every re-ask pays for it
 * again — including on paths where inference had already started. That
 * arithmetic was put to the user with these numbers in front of them and the
 * larger magnitude was chosen deliberately. It is an informed acceptance, not
 * an oversight; do not quietly re-litigate it here.
 *
 * ── THE SIDE EFFECT, WHICH IS NOT OPTIONAL ──────────────────────────────────
 *
 * The watchdog is GLOBAL to the child, so it amplifies every 503 claudish can
 * emit and not only the recovery one: the stream-head sniffer's exhaustion and
 * `exhaustedChainStatus`'s all-transient chain also become ~300-attempt
 * retries. Neither of those opens an episode or a pane, so while the client
 * loops on them the reason is legible NOWHERE — they degrade to "API error ·
 * Retrying" for far longer than before. More retry is the intended remedy for
 * both (an upstream overload is genuinely transient, which is why they are
 * 503s at all), but the visibility argument that earns the recovery 503 its
 * retryable status does not extend to them. That gap is the honest price of
 * one process-wide switch, and there is no narrower lever: the variable is
 * fixed at spawn and cannot key on whether a banner exists.
 *
 * ── THE THREE GATES, AND WHY IT IS NOT JUST THE UI SWITCH ───────────────────
 *
 * All three must hold, because the cost above is only worth paying by a launch
 * that gets the benefit:
 *
 *   1. `resolveRecoveryEnabled()` — the ladder itself. `--no-recovery` /
 *      `CLAUDISH_RECOVERY=0` restores pre-recovery behaviour "byte for byte"
 *      (RISK-7), and an exhaustion that answers today's immediate 400 hands
 *      nothing back for the client to re-ask. A CI run that explicitly opted
 *      out must not be left looping ~300 times on an unrelated 503.
 *   2. `resolveRecoveryUi()` — the user's configuration, flag > env > project >
 *      global > true. Off means no pane, therefore no lease, therefore an
 *      inline 400 at exhaustion. Surface and reach move together or not at all.
 *   3. `paneEligible` — whether THIS LAUNCH can obtain a surface at all, from
 *      `magmuxPaneCapability()`. It is a launch-order fact, not a preference:
 *      false in `-p`, in `--stdin`, with no TTY, and on a machine without
 *      magmux. None of those can ever hold the lease a recovery 503 requires,
 *      so for them the watchdog is the RISK-6 exposure with none of the
 *      recovery benefit, applied to every unrelated 503 the session sees.
 *
 * Gate 3 is why the caller must ask about eligibility BEFORE finalising the
 * child environment — see `magmuxPaneCapability`, which is side-effect free for
 * exactly that reason.
 */
export function retryWatchdogEnv(opts: { paneEligible: boolean }): Record<string, string> {
  if (!opts.paneEligible) return {};
  // Gates 1 and 2, as one predicate — the same one `claude-runner.ts` asks
  // before wrapping the launch, so "may we wrap" and "may we amplify the
  // client's retries" are answered by one expression rather than by two that
  // have already drifted once.
  return recoverySurfaceAllowed() ? { CLAUDE_CODE_RETRY_WATCHDOG: "1" } : {};
}

/** Set alongside the watchdog to record that CLAUDISH set it, not the user. */
export const RETRY_WATCHDOG_OWNER_ENV = "CLAUDISH_SET_RETRY_WATCHDOG";

/**
 * Apply the watchdog decision to the environment Claude Code will receive.
 *
 * ── WHY `retryWatchdogEnv` RETURNING `{}` WAS NOT ENOUGH ────────────────────
 *
 * The child environment starts as a copy of claudish's own. A wrapped session
 * exports the watchdog to Claude Code, every process Claude Code starts
 * inherits it, and a NESTED claudish — `claudish -p` run from the Bash tool, or
 * the child `claudish` the MCP server spawns for `team` and `run_prompt` —
 * copied it straight through, because failing all three gates only meant
 * adding nothing. A headless nested run then looped ~300 times on every 503
 * with no banner anywhere: the exact cost the gates exist to refuse.
 *
 * So a failed gate now REMOVES a watchdog that a parent claudish exported.
 * It cannot remove every inherited one: a user who set the variable in their
 * own shell chose it, and that is theirs to keep. The owner marker is what
 * tells the two apart — an inherited watchdog WITH the marker is a claudish's,
 * and one without is the user's.
 *
 * The marker is set only when claudish INTRODUCES the watchdog. Stamped on top
 * of a value the user already set, it would claim the user's choice as
 * claudish's, and a deeper nested launch whose gates fail would then delete
 * it. A user's watchdog therefore stays unmarked all the way down the tree.
 */
export function applyRetryWatchdog(
  env: Record<string, string | undefined>,
  opts: { paneEligible: boolean }
): void {
  const grant = retryWatchdogEnv(opts);
  if (grant.CLAUDE_CODE_RETRY_WATCHDOG) {
    const usersOwn =
      env.CLAUDE_CODE_RETRY_WATCHDOG !== undefined && env[RETRY_WATCHDOG_OWNER_ENV] !== "1";
    Object.assign(env, grant);
    if (!usersOwn) env[RETRY_WATCHDOG_OWNER_ENV] = "1";
    return;
  }
  if (env[RETRY_WATCHDOG_OWNER_ENV] === "1") {
    delete env.CLAUDE_CODE_RETRY_WATCHDOG;
    delete env[RETRY_WATCHDOG_OWNER_ENV];
  }
}
