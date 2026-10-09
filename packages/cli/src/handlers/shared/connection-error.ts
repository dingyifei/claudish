/**
 * Connection-error classification.
 *
 * Distinguishes a LOCAL network failure (DNS can't resolve, connection refused,
 * host unreachable) from an upstream HTTP error. When claudish's proxy can't
 * even REACH the provider, that's the user's machine/network — reporting it as a
 * generic 500 sends people hunting for a claudish or provider bug. (A Tailscale
 * MagicDNS outage making chatgpt.com unresolvable, which broke the Codex CLI,
 * the desktop app, and claudish identically, is what motivated this.) Tagging
 * these as connection errors lets both Claude Code and the config probe show an
 * honest "can't reach host — check your network/DNS" instead.
 */

export type ConnectionErrorKind = "dns" | "refused" | "unreachable";

/** Node/undici syscall codes we treat as a failure to REACH the host. */
const CODE_KIND: Record<string, ConnectionErrorKind> = {
  ENOTFOUND: "dns", // getaddrinfo: host not found
  EAI_AGAIN: "dns", // getaddrinfo: temporary DNS failure
  ECONNREFUSED: "refused", // nothing listening at the endpoint
  ETIMEDOUT: "unreachable", // connect timed out
  ECONNRESET: "unreachable", // connection reset before response
  ENETUNREACH: "unreachable", // network unreachable
  EHOSTUNREACH: "unreachable", // host unreachable
  EPIPE: "unreachable", // broken pipe during connect
  UND_ERR_CONNECT_TIMEOUT: "unreachable", // undici connect timeout
  UND_ERR_SOCKET: "unreachable", // undici socket closed

  // --- Bun runtime codes ---------------------------------------------------
  // claudish RUNS on Bun, and Bun's fetch does NOT use Node's errno names and
  // does NOT populate `.cause` — it throws a flat Error carrying its own `code`
  // plus `path`/`errno` own-properties. Without these entries every real-world
  // connect failure fell through classification into a raw 500 (and, via Hono's
  // default `console.error(err)` handler, a multi-line dump onto Claude Code's
  // TTY). Note Bun reports a DNS failure as ConnectionRefused too — see
  // buildConnectionErrorMessage for how that ambiguity is resolved.
  ConnectionRefused: "refused", // Bun: refused OR unresolvable host
  ConnectionClosed: "unreachable", // Bun: peer closed mid-connect
  FailedToOpenSocket: "unreachable", // Bun: could not open the socket
  ERR_SOCKET_CLOSED: "unreachable", // Bun: socket closed before response
};

/**
 * Bun's single phrasing for every connect-level failure. Bun sets a `code` in
 * current releases, but older/compiled builds surface only this message, so we
 * match it as a fallback.
 */
const BUN_CONNECT_MESSAGE = /unable to connect\. is the computer able to access the url\?/i;

/**
 * Error NAMES that mean the same thing as a connect code, matched separately
 * because they do not arrive as one — AND ONLY WHEN THE SIGNAL WAS OURS.
 *
 * `AbortSignal.timeout(...)` rejects with a `DOMException` whose `name` is
 * `TimeoutError` and whose `code` is the NUMBER 23 — so `findConnectionCode`'s
 * `typeof e.code === "string"` test skipped it, its message ("The operation
 * timed out.") matched no fallback, and classification returned **null**. A
 * REACHABILITY PROBE that hung therefore fell straight through into a bare
 * 500, with none of the actionable wording every other unreachable-host
 * failure gets.
 *
 * ── WHY THE NAME ALONE IS NOT THE DISCRIMINATOR ─────────────────────────────
 *
 * `TimeoutError` is also what a TRANSPORT'S OWN request ceiling rejects with.
 * `vertex-oauth.ts` puts `AbortSignal.timeout(30000)` on the *inference* call
 * and `local.ts` a ten-minute one. Classifying by name alone turned "the model
 * took longer than its transport's ceiling" — a LATENCY event, ordinary for a
 * thinking model on a streaming endpoint — into `unreachable`: it entered the
 * retry ladder, took the tier-2 handoff, and with `CLAUDE_CODE_RETRY_WATCHDOG`
 * on it was re-POSTed ~300 times, each one running ONE MORE REAL BILLED
 * INFERENCE against a host that had answered the TCP connect and was already
 * generating. RISK-6 (`network-recovery.md` §7) was accepted for
 * `ECONNRESET`/`EPIPE` on a genuine network fault. It was never accepted for a
 * latency event, which is neither a network fault nor transient — and
 * `buildConnectionErrorMessage` then told the user to check their VPN and DNS
 * for a host that was mid-generation.
 *
 * So the discriminator is the SIGNAL'S ORIGIN, carried on the error as an own
 * property, not the name:
 *
 *   - the ladder's per-attempt clamp (`transient-retry.ts`) — WE gave up on
 *     this attempt, and re-issuing is the entire point;
 *   - a reachability PROBE we issued with our own short timeout (`local.ts`'s
 *     5 s `/api/tags`) — WE asked "is anything there" and got no answer.
 *
 * Both mean "we could not get a response out of this host inside a window WE
 * chose". A transport's inference ceiling means something else, so it keeps
 * its pre-recovery route out of here: unclassified, rethrown, untouched.
 *
 * ONLY `TimeoutError`. `AbortError` is deliberately absent and must stay
 * absent: it is how a client says it has gone away and how our own per-attempt
 * clamp's sibling signal reports a deliberate cancellation, and treating a
 * cancellation as a network fault would retry work nobody is waiting for.
 */
const NAME_KIND: Record<string, ConnectionErrorKind> = {
  TimeoutError: "unreachable",
};

/**
 * The own-property that says "this timeout is CLAUDISH'S OWN".
 *
 * Non-enumerable on purpose: it must not change how an error serialises into a
 * log, a stats record or an upstream error body.
 */
const OWN_TIMEOUT_FLAG = "claudishOwnTimeout";

/**
 * Tag an error as raised by a timeout CLAUDISH set on a reachability question
 * of its own — the retry ladder's per-attempt clamp, or a health probe.
 *
 * Returns the same object, so it composes inside an `abort(...)` call or an
 * assignment. Defensive about frozen errors: a failure to tag degrades to
 * "unclassified", which is the safe direction (no ladder, no re-issue).
 */
export function markOwnTimeout<T>(error: T): T {
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, OWN_TIMEOUT_FLAG, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      /* frozen — falls through to unclassified, which is the safe direction */
    }
  }
  return error;
}

/** Was this error raised by one of OUR timeouts? See `markOwnTimeout`. */
function isOwnTimeout(error: unknown): boolean {
  return Boolean((error as Record<string, unknown> | null | undefined)?.[OWN_TIMEOUT_FLAG]);
}

/**
 * Walk an error and its `cause` chain (undici's `TypeError: fetch failed` wraps
 * the real syscall error in `.cause`) and return the first known connection
 * code. Falls back to a message match for the macOS getaddrinfo phrasing that
 * some runtimes surface without a `.code`.
 */
function findConnectionCode(error: unknown): string | null {
  let e: any = error;
  const seen = new Set<unknown>();
  for (let depth = 0; e && typeof e === "object" && depth < 8 && !seen.has(e); depth++) {
    seen.add(e);
    if (typeof e.code === "string" && e.code in CODE_KIND) return e.code;
    // A DOMException carries a NUMERIC `code`, so the name is the only handle
    // on it. Walked at the same depth as `.code`, because a transport that
    // rethrows with `{ cause }` buries a hung-probe timeout just as deeply as
    // it buries a refusal.
    //
    // `isOwnTimeout(e)` is the load-bearing half: a `TimeoutError` raised by a
    // transport's own INFERENCE ceiling is not a reachability fact and must not
    // enter the ladder. See `NAME_KIND`'s header for what that cost.
    if (typeof e.name === "string" && e.name in NAME_KIND && isOwnTimeout(e)) return e.name;
    e = e.cause;
  }
  const msg = String((error as any)?.message ?? error ?? "");
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|nodename nor servname/i.test(msg)) return "ENOTFOUND";
  if (BUN_CONNECT_MESSAGE.test(msg)) return "ConnectionRefused";
  return null;
}

/**
 * True when the endpoint points at this machine (loopback / unspecified).
 *
 * Exported because it is the ONLY sound discriminator for "this is a local
 * server the user can start" at handler level. Branching on the error CODE
 * instead does not work: on macOS an unrouted remote address reports
 * `ECONNREFUSED` after 75 s, the same code a loopback port refuses in 5 ms.
 * Only the endpoint — or elapsed time — separates them.
 */
export function isLoopback(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint);
    return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/i.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Classify a thrown fetch/connect error. Returns `null` when the error is NOT a
 * reach-the-host failure (the caller should rethrow and let normal HTTP-error
 * handling apply).
 */
export function classifyConnectionError(
  error: unknown
): { kind: ConnectionErrorKind; code: string } | null {
  const code = findConnectionCode(error);
  if (!code) return null;
  return { kind: CODE_KIND[code] ?? NAME_KIND[code] ?? "unreachable", code };
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

/** Build the user-facing, actionable message for a connection failure. */
export function buildConnectionErrorMessage(
  kind: ConnectionErrorKind,
  displayName: string,
  endpoint: string
): string {
  const host = hostOf(endpoint);
  switch (kind) {
    case "dns":
      return `Cannot resolve ${host} for ${displayName}. This is a DNS/network problem on your machine — check your internet connection, VPN, or DNS resolver (e.g. Tailscale MagicDNS) — not ${displayName}.`;
    case "refused":
      // "Refused" is only unambiguous for a local endpoint. Bun reports an
      // unresolvable REMOTE host as ConnectionRefused too, so "make sure the
      // server is running" would send the user to restart chatgpt.com. For a
      // remote host, give the DNS/network wording instead — that is the far
      // likelier cause, and the advice is right either way.
      if (isLoopback(endpoint)) {
        return `Cannot connect to ${displayName} at ${endpoint}. Make sure the server is running.`;
      }
      return `Cannot reach ${host} for ${displayName}. This is a network problem on your machine — check your internet connection, VPN, or DNS resolver (e.g. Tailscale MagicDNS) — not ${displayName}.`;
    case "unreachable":
      return `Cannot reach ${displayName} at ${endpoint}. Check your network connection.`;
  }
}

/**
 * `3m 45s`, `45s`, `0s`. Never negative, never fractional.
 *
 * Deliberately a separate implementation from the pane's formatter of the same
 * shape: the pane runs in ANOTHER PROCESS and shares no module with this one,
 * and importing across that boundary is what the recovery wire protocol exists
 * to avoid.
 */
export function formatHoldDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * The sentence an EXHAUSTED tier-1 hold carries on its retryable 503.
 *
 * It is `buildConnectionErrorMessage`'s own sentence plus a recovery clause,
 * and it has to stay built that way: the inline 400 and the handed-back 503
 * describe ONE fault, and two sentences that drift tell the user two different
 * stories about it.
 *
 * ── WHAT THIS SENTENCE MUST NEVER SAY ───────────────────────────────────────
 *
 * `fallback-handler.ts`'s `hasQuotaExhaustionWording` is the FIRST statement in
 * `isRetryableError`'s body and is status-agnostic on purpose. Its phrase list
 * contains the bare substring `"quota"`, plus `"usage limit"`, `"plan limit"`,
 * `"daily limit"`, `"billing cycle"`, `"credit balance"`, `"out of credits"`
 * and `"exceeded your current"`. A 503 whose MESSAGE trips that list advances
 * the fallback chain and moves a subscription user onto metered billing during
 * an outage.
 *
 * The structural defence is the `x-claudish-recovery` marker
 * (`recovery-marker.ts`), which takes the message out of that decision
 * entirely. This wording rule is the belt behind that brace, and it is asserted
 * directly on the composed sentence in `recovery-status.test.ts` — so a future
 * edit that reaches for "retry quota" or "attempt limit" fails a test rather
 * than a user's invoice.
 */
export function buildRecoveryHoldMessage(
  reason: string,
  attempts: number,
  elapsedMs: number
): string {
  return (
    `${reason} claudish retried ${attempts}× over ${formatHoldDuration(elapsedMs)} ` +
    "without reaching it — still trying, watch the recovery pane."
  );
}
