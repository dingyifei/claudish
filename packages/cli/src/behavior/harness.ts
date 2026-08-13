/**
 * Detects Claude Code harness state from an in-flight request.
 *
 * Every string Claude Code emits that we match on lives HERE, not in the rules.
 * These anchors are upstream prompt text: they can change without notice on any
 * CC release, so keeping them in one file makes a break one edit to fix rather
 * than a hunt through every rule.
 *
 * Anchors verified against the Claude Code 2.1.220 binary.
 */

import type { HarnessFacts } from "./types.js";

/**
 * Plan-file path anchors, in the three forms CC emits.
 *
 * The path is always taken FROM the reminder. It is never reconstructed from a
 * default directory, because CC exposes a `planDir` setting ("Custom directory
 * for plan files, relative to project root. If not set, defaults to
 * ~/.claude/plans/") — assuming the default would silently misfire for anyone
 * who changed it, which is precisely the class of bug this layer exists to stop.
 */
const PLAN_PATH_PATTERNS: RegExp[] = [
  /You should create your plan at\s+(\S+?\.md)/,
  /A plan file already exists at\s+(\S+?\.md)/,
  /Read-only except plan file\s*\(([^)]+\.md)\)/,
];

/**
 * Cheap pre-test, so the anchor regexes are not run over every message of a
 * 180K-token conversation.
 *
 * MUST be a superset of the anchors above. An earlier version listed only
 * "plan file" / "Plan mode is active", which does not appear in the
 * "You should create your plan at …" anchor — so that anchor was short-circuited
 * away and never evaluated. It only worked in practice because Claude Code
 * happens to emit "No plan file exists yet." in the same block. Any new anchor
 * must have a matching alternative here.
 */
const PLAN_MODE_HINT = /plan file|create your plan at|Plan mode is active|Plan mode still active/i;

/** A skill Claude Code has offered the model this turn. */
export interface AvailableSkill {
  name: string;
  description: string;
}

/**
 * Anchor for the skill listing Claude Code puts in the system prompt.
 *
 * The list is already in every request — the layer simply never read it. That
 * matters because "the model did not invoke an available skill" is a divergence
 * we can only detect if we know what was on offer, and the supervisor's answer
 * to it is to INJECT the relevant content rather than ask the model to go and
 * load it.
 */
const SKILL_SECTION = /The following skills are available[^\n]*\n/;
/** `- name: description` — the shape CC uses for each entry. */
const SKILL_LINE = /^-\s+([a-z0-9][a-z0-9:_-]*):\s*(.+)$/i;

/**
 * Parse the skills Claude Code offered, in listing order.
 *
 * Returns `[]` when no listing is present, which is the common case for a
 * request built without skills — callers must treat empty as "unknown", not as
 * "the user has no skills".
 */
export function extractAvailableSkills(systemText: string): AvailableSkill[] {
  if (!systemText) return [];
  const start = SKILL_SECTION.exec(systemText);
  if (!start) return [];

  const out: AvailableSkill[] = [];
  const body = systemText.slice(start.index + start[0].length);
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // A blank line does not end the list — CC separates entries with them.
    if (!trimmed) continue;
    const m = SKILL_LINE.exec(trimmed);
    if (!m) {
      // First non-blank, non-entry line ends the section. Without this the
      // parser would swallow the remainder of the system prompt.
      if (out.length > 0) break;
      continue;
    }
    out.push({ name: m[1], description: m[2].trim() });
  }
  return out;
}

/**
 * Extract the Claude Code session id from a request.
 *
 * Claude Code sends it inside `metadata.user_id`, which is itself a JSON STRING
 * rather than an object:
 *
 *   metadata.user_id = '{"device_id":"073c…","account_uuid":"","session_id":"ce7d…"}'
 *
 * The session id is stable for every turn of one Claude Code session, which
 * makes it the correct key for anything that has to survive between turns —
 * queued corrections, cross-turn pattern state. It needs no fingerprinting and
 * cannot collide between concurrent conversations.
 *
 * `device_id` and `account_uuid` from that same blob are DELIBERATELY discarded
 * and must never be journalled or uploaded: device_id is a stable machine
 * identifier, i.e. exactly the kind of value the journal's whole design is
 * structured to avoid carrying.
 */
export function extractSessionId(claudeRequest: any): string | undefined {
  const raw = claudeRequest?.metadata?.user_id;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    const id = parsed?.session_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    // Older or non-Claude-Code clients may send a plain string here.
    return undefined;
  }
}

/** Collect the text of a message/system entry, whatever shape it arrived in. */
function textOf(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let out = "";
    for (const part of value) {
      if (typeof part === "string") out += part;
      else if (typeof part?.text === "string") out += part.text;
      else if (typeof part?.content === "string") out += part.content;
    }
    return out;
  }
  if (typeof value?.text === "string") return value.text;
  return "";
}

function matchPlanPath(text: string): string | undefined {
  if (!PLAN_MODE_HINT.test(text)) return undefined;
  for (const re of PLAN_PATH_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * Extract harness facts from a normalized Claude-format request.
 *
 * Scans the system prompt, then walks messages from the END backwards. The
 * plan-mode reminder is re-injected on the most recent turn, so the backwards
 * walk finds it in the first message or two on a live request — which matters
 * when the conversation is the ~180K tokens where this bug actually bites.
 */
export function detectHarnessFacts(claudeRequest: any): HarnessFacts {
  const facts: HarnessFacts = { planModeActive: false };

  let planPath = matchPlanPath(textOf(claudeRequest?.system));

  if (!planPath && Array.isArray(claudeRequest?.messages)) {
    const messages = claudeRequest.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      planPath = matchPlanPath(textOf(messages[i]?.content));
      if (planPath) break;
    }
  }

  if (planPath) {
    facts.planModeActive = true;
    facts.planFilePath = planPath;
    const slash = planPath.lastIndexOf("/");
    if (slash > 0) facts.planDir = planPath.slice(0, slash);
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Auto-mode permission classifier
//
// In `--permission-mode auto`, Claude Code sends a dedicated security-monitor
// request to decide whether each tool call is safe to run unattended. claudish
// can reroute just that request to a real Claude model (see
// classifier-passthrough.ts); the anchors it is recognised by live here with
// every other CC prompt string we match on.
// ---------------------------------------------------------------------------

/**
 * Opening sentence of the auto-mode permission classifier's system prompt.
 *
 * Verified verbatim in the Claude Code 2.1.226 binary and in a live capture at
 * the same version. Re-verify from a `CLAUDISH_CLASSIFIER_DEBUG=1` capture if
 * the wording ever drifts — this is a security control that fails OPEN, so a
 * silent miss sends the classifier to whatever foreign model the tier maps to.
 */
const CLASSIFIER_SYSTEM_MARKER = "You are a security monitor for autonomous AI coding agents.";

/**
 * Upper bound on a classifier request's `max_tokens`, for the shape tripwire
 * below. Observed at CC 2.1.226: 64 on five of six captured requests and 8192
 * on the sixth, against 64000 for the main loop — so the ceiling sits well
 * clear of both. Widen it rather than narrow it if CC starts asking for more.
 */
const CLASSIFIER_MAX_TOKENS_CEILING = 16_384;

/**
 * Allocation-free test for "text, ignoring leading whitespace, starts with the
 * marker". Avoids `trimStart()`, which would copy the whole block: the captured
 * security-monitor prompt is ~110 KB, and this runs on every proxied request.
 */
function startsWithMarker(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    // space, tab, LF, CR, form feed, vertical tab
    if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 13 && ch !== 12 && ch !== 11) break;
    i++;
  }
  return text.startsWith(CLASSIFIER_SYSTEM_MARKER, i);
}

/**
 * Extract the text of one Claude Messages `system` content block, or null when
 * the block carries none. Accepts a bare string element or `{type:"text",text}`.
 */
function systemBlockText(block: unknown): string | null {
  if (typeof block === "string") return block;
  if (
    block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  ) {
    return (block as { text: string }).text;
  }
  return null;
}

/**
 * True iff the request body is Claude Code's auto-mode permission classifier —
 * i.e. ANY of its `system` text blocks starts with CLASSIFIER_SYSTEM_MARKER.
 *
 * EVERY block is scanned; the marker's index is deliberately not assumed. The
 * `system` array is a multi-block composition assembled by Claude Code (a
 * billing header, CLAUDE.md and project rules, output styles, the monitor
 * prompt itself) whose order and count are not a contract and have already
 * changed across CC releases. A full scan is a superset of an index check,
 * short-circuits on the first hit, and allocates nothing — so pinning an index
 * would buy nothing and break silently on the next reshuffle.
 *
 * (`stripBillingHeader` in transform.ts does not apply here: it runs inside
 * ComposedHandler → transformOpenAIToClaude, which is downstream of the routing
 * decision this feeds and never runs on the NativeHandler path.)
 *
 * Handles the string-vs-array `system` duality. Never throws.
 */
export function isAutoModeClassifierRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const system = (body as { system?: unknown }).system;
  if (typeof system === "string") return startsWithMarker(system);
  if (!Array.isArray(system)) return false;
  for (const block of system) {
    const text = systemBlockText(block);
    if (text !== null && startsWithMarker(text)) return true;
  }
  return false;
}

/**
 * Structural tripwire for a request that LOOKS like the auto-mode classifier
 * without carrying the marker.
 *
 * Exists because marker matching fails OPEN: if Claude Code rewords the prompt
 * by one character, detection silently stops and every classifier call goes
 * back to the foreign main-loop provider — the exact bug the passthrough was
 * written to fix. This never routes anything; it only decides when to shout.
 *
 * Deliberately structural rather than content-based, and cheap-test-first.
 * Thresholds are from a live CC 2.1.226 capture (6 classifier requests vs 10
 * main-loop): they separated the two sets completely. The `system.length >= 2`
 * clause is load-bearing rather than decorative — Claude Code's startup
 * connectivity probe (`max_tokens: 1`, no tools, non-streaming, NO system)
 * satisfies the other three and is excluded only by that one.
 */
export function looksLikeClassifierShape(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as {
    stream?: unknown;
    tools?: unknown;
    max_tokens?: unknown;
    system?: unknown;
  };
  if (b.stream === true) return false;
  if (Array.isArray(b.tools) && b.tools.length > 0) return false;
  if (typeof b.max_tokens !== "number" || b.max_tokens > CLASSIFIER_MAX_TOKENS_CEILING)
    return false;
  return Array.isArray(b.system) && b.system.length >= 2;
}
