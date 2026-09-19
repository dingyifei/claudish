/**
 * Anthropic error envelope wrapper.
 * All proxy error responses MUST use this format.
 */

import { isContextOverflowError } from "./request-shape.js";

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "overloaded_error"
  | "api_error"
  | "connection_error";

export interface AnthropicErrorEnvelope {
  type: "error";
  error: {
    type: AnthropicErrorType;
    message: string;
    /**
     * Original upstream HTTP status, set when the proxy REMAPS a terminal
     * upstream error (401/403/terminal-429) to 400 so Claude Code surfaces it
     * instead of silently retrying. Machine-readable: probe classification
     * reads it to report the real upstream failure (e.g. "auth failed · 401")
     * instead of the proxy's 400. Extra JSON fields are ignored by Claude Code.
     */
    upstream_status?: number;
  };
}

/**
 * Map HTTP status codes to Anthropic error types.
 */
export function statusToErrorType(status: number): AnthropicErrorType {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    case 503:
    case 529:
      return "overloaded_error";
    default:
      return "api_error";
  }
}

/** Hard cap on an error message. Long enough to stay actionable, short enough
 *  that a client rendering it inline can't be pushed off-screen. */
const MAX_ERROR_MESSAGE_LENGTH = 600;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

/**
 * Flatten an error message into a single terminal-safe line.
 *
 * Claude Code renders a proxy error message INLINE in its "API error · Retrying"
 * banner, inside a TUI frame it redraws in place. A message carrying newlines,
 * tabs, or ANSI escapes therefore doesn't just look bad — it moves the cursor
 * and overwrites whatever the TUI had already painted, which is how a raw Bun
 * connect-error dump (`error: …` / `path: …` / `errno: …` / `code: …`) shredded
 * the status line and surrounding rows.
 *
 * claudish does not control what a provider puts in an error body, so the fix
 * has to live at the boundary: every message we emit is collapsed to one line,
 * stripped of control bytes, and length-capped.
 */
export function sanitizeErrorMessage(
  message: string,
  maxLength = MAX_ERROR_MESSAGE_LENGTH
): string {
  const flattened = String(message ?? "")
    .replace(ANSI_ESCAPE, "") // cursor moves / colors — must go before control-char strip
    .replace(CONTROL_CHARS, " ") // newlines, tabs, bells, backspaces → space
    .replace(/\s+/g, " ")
    .trim();

  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Create a properly formatted Anthropic error envelope.
 *
 * The message is always sanitized (see sanitizeErrorMessage) — this is the one
 * choke point every proxy error response passes through, so it is the only
 * place that can guarantee a client-rendered error can't corrupt a TUI.
 *
 * @param status         - HTTP status code (used to infer error type if not provided)
 * @param message        - Human-readable error message
 * @param errorType      - Override the error type (e.g., from a provider's structured error)
 * @param upstreamStatus - Original upstream HTTP status when this envelope remaps
 *                         a terminal error to a different status (see interface doc)
 */
export function wrapAnthropicError(
  status: number,
  message: string,
  errorType?: string,
  upstreamStatus?: number
): AnthropicErrorEnvelope {
  const type = (errorType as AnthropicErrorType) || statusToErrorType(status);
  const error: AnthropicErrorEnvelope["error"] = { type, message: sanitizeErrorMessage(message) };
  if (upstreamStatus !== undefined) error.upstream_status = upstreamStatus;
  return { type: "error", error };
}

/**
 * Recover the ORIGINAL upstream status from a remapped error body.
 *
 * The remap (`composed-handler.ts`, the single site that passes a fourth
 * argument to `wrapAnthropicError`) turns a terminal upstream failure into an
 * HTTP 400 so Claude Code surfaces it inline instead of burying it under ten
 * rounds of "API error · Retrying". That is right for the CLIENT and wrong for
 * anything downstream that still has a decision to make from the status, so the
 * true status rides along in this field.
 *
 * Two callers need it and they were not sharing one reader: `probe-live.ts`
 * (which would otherwise bucket a remapped auth failure as a generic
 * "error · 400") and `fallback-handler.ts` (#148 — which would otherwise stop a
 * provider chain dead on an error that the very next candidate could serve).
 * A private copy in each is how they drift.
 *
 * Returns `undefined` for a body that is not JSON, carries no field, or carries
 * a non-numeric one. Never throws: it runs on the error path, where something
 * has already gone wrong.
 */
export function extractUpstreamStatus(body: string): number | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    const status = parsed?.error?.upstream_status;
    return typeof status === "number" ? status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull the most useful human-readable message out of an arbitrary provider
 * error body (already JSON-parsed, or a raw string). Mirrors the extraction
 * ladder in ensureAnthropicErrorFormat but usable standalone.
 */
export function extractProviderMessage(body: any): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  const candidates = [
    body?.error?.message,
    body?.message,
    typeof body?.error === "string" ? body.error : undefined,
    body?.error?.detail,
    body?.detail,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
    // FastAPI validation errors use `detail: [{ msg, loc, ... }]`.
    if (Array.isArray(c)) {
      const first = c.find((e) => typeof e?.msg === "string" && e.msg.length > 0);
      if (first) return first.msg;
    }
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * Decide whether an upstream error is *terminal* — i.e. retrying will not help,
 * so claudish should stop Claude Code's silent retry loop and surface the real
 * reason inline. Generalizes the terminal-429 special case to any status that
 * carries an auth / quota / billing / model-unsupported signal.
 *
 * Transient errors (plain rate limits, overloaded, 5xx blips) are NOT terminal:
 * those legitimately recover on retry, so we leave the retryable status intact.
 *
 * Substring matching is deliberately CONSERVATIVE. A false positive here is
 * worse than a false negative: classifying a transient error as terminal stops
 * a retry that would have succeeded, whereas missing a terminal error only
 * costs a few wasted retries before the final attempt surfaces the real reason.
 * So:
 *   - Quota/billing phrases (`insufficient balance`, `out of credits`, …) are
 *     specific enough to trust under ANY status — no transient blip phrases it
 *     that way.
 *   - Generic English phrases (`not supported`, `subscription … expired`) are
 *     gated to non-5xx statuses, because a 5xx is a SERVER failure (retry-worthy)
 *     and such prose can legitimately appear inside a transient 5xx body
 *     (e.g. "Retry-After not supported by upstream gateway; service overloaded").
 *
 * @param status     - upstream HTTP status
 * @param bodyText   - raw upstream error body (string)
 * @param terminal429 - result of provider-specific isTerminal429(bodyText)
 */
export function isTerminalError(status: number, bodyText: string, terminal429: boolean): boolean {
  // Auth / permission failures never recover on retry.
  if (status === 401 || status === 403) return true;
  // 426 Upgrade Required is terminal BY DEFINITION — RFC 7231: the server
  // "refuses to perform the request using the current protocol but might be
  // willing to after the client upgrades". Re-sending the identical request can
  // never succeed, so a retry loop only buries the fix.
  //
  // Not hypothetical: Grok Build's proxy enforces a minimum CLI version and
  // answers 426 with `Your Grok CLI version (X) is outdated. Please update ...
  // via \`grok update\``. That body matches none of the phrase lists below, so
  // it fell through as retryable and the one actionable sentence was replaced
  // by ~11 rounds of "API error · Retrying".
  if (status === 426) return true;
  // Billing/quota exhaustion surfaced as a 429 (provider-specific signals).
  if (status === 429 && terminal429) return true;
  // A prompt larger than the model's context window is terminal BY ARITHMETIC:
  // re-sending the identical request can only produce the identical rejection.
  // Terminal here means the envelope is remapped to 400 and carries the rich
  // surfaced message, which is the only path on which the client ever sees the
  // `prompt is too long` phrase it pattern-matches — the plain pass-through
  // forwards the provider's own wording, which no client recognises.
  //
  // It does NOT change the fallback chain: `fallback-handler` only widens on a
  // recovered upstream 401/402/403/429, and an overflow is none of those.
  if (isContextOverflowError(status, bodyText)) return true;

  const lower = (bodyText || "").toLowerCase();

  // Quota/billing signals: specific enough to trust under any status. A
  // transient overload never describes itself as "insufficient balance".
  if (
    lower.includes("insufficient balance") ||
    lower.includes("insufficient_balance") ||
    lower.includes("insufficient_quota") ||
    lower.includes("insufficient quota") ||
    lower.includes("billing_not_active") ||
    lower.includes("billing not active") ||
    lower.includes("out of credits") ||
    lower.includes("no credits remaining") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("quota_exceeded")
  ) {
    return true;
  }

  // Generic-English terminal phrases (model-unsupported, expired subscription).
  // These appear in real prose, so gate them to non-5xx statuses: a 5xx is a
  // server failure that should retry, and "not supported" can show up inside a
  // transient gateway message. A model/account problem comes back as 4xx.
  const isServerError = status >= 500;
  if (!isServerError) {
    if (
      lower.includes("not supported") ||
      lower.includes("unsupported model") ||
      lower.includes("unsupported_model") ||
      lower.includes("model not found") ||
      lower.includes("model_not_found") ||
      lower.includes("unknown model") ||
      (lower.includes("subscription") && lower.includes("expired"))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Build a single user-readable line that survives in the chat transcript when
 * an upstream error is surfaced (instead of Claude Code's opaque
 * "API error · Retrying"). Combines provider attribution, HTTP status, a
 * recovery hint, and the real upstream message.
 *
 * Example:
 *   "Sakana Fugu error (HTTP 401): Check API key / OAuth credentials. — invalid api key"
 */
export function buildSurfacedErrorMessage(opts: {
  providerDisplayName: string;
  status: number;
  hint: string;
  providerMessage: string;
  /**
   * A phrase the CLIENT pattern-matches, placed at the very front of the line.
   *
   * It LEADS for two independent reasons, and either alone would be enough.
   * `sanitizeErrorMessage` caps the message at 600 characters, so a phrase
   * appended after provider prose can be cut off — and a client matching a
   * truncated phrase misses silently. And Claude Code's own message classifier
   * tests `startsWith("prompt is too long")`, not a substring, so the position
   * is itself load-bearing.
   *
   * Only `CONTEXT_OVERFLOW_PHRASE` uses this today. See `request-shape.ts`.
   */
  leadPhrase?: string;
}): string {
  const { providerDisplayName, status, hint, providerMessage, leadPhrase } = opts;
  const head = `${providerDisplayName} error (HTTP ${status})`;
  const parts: string[] = [head];
  if (hint) parts[0] = `${head}: ${hint}`;
  if (leadPhrase && !parts[0].startsWith(leadPhrase)) parts[0] = `${leadPhrase} — ${parts[0]}`;
  const detail = (providerMessage || "").trim();
  if (detail && !parts[0].includes(detail)) {
    // Keep the surfaced line bounded — providers occasionally echo huge bodies.
    const trimmed = detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
    parts.push(`— ${trimmed}`);
  }
  return parts.join(" ");
}

/**
 * Check if a parsed JSON body is already in Anthropic error envelope format.
 * Returns the body as-is if valid, or wraps it if not.
 */
export function ensureAnthropicErrorFormat(status: number, body: any): AnthropicErrorEnvelope {
  // Already correct format: { type: "error", error: { type: "...", message: "..." } }
  // Still sanitize the message: a well-formed envelope is no guarantee of a
  // well-behaved message, and this pass-through is the one path where provider
  // text reaches the client without claudish having composed it.
  if (
    body?.type === "error" &&
    typeof body?.error?.type === "string" &&
    typeof body?.error?.message === "string"
  ) {
    return { ...body, error: { ...body.error, message: sanitizeErrorMessage(body.error.message) } };
  }

  // Partial format: { error: { type: "...", message: "..." } } (missing outer type)
  if (typeof body?.error?.type === "string" && typeof body?.error?.message === "string") {
    return {
      type: "error",
      error: { ...body.error, message: sanitizeErrorMessage(body.error.message) },
    };
  }

  // Provider returned some other JSON structure -- extract best message
  const message =
    body?.error?.message ||
    body?.message ||
    body?.error ||
    (typeof body === "string" ? body : JSON.stringify(body));

  const errorType = body?.error?.type || body?.type || body?.code;

  return wrapAnthropicError(status, String(message), errorType);
}
