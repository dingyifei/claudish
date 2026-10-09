/**
 * Tier 2 — the status flip, and the one thing in this feature that costs money
 * rather than time.
 *
 * At the end of a tier-1 hold `ComposedHandler` chooses between two answers:
 *
 *   lease valid  → **503 `overloaded_error`**, `x-should-retry: true`,
 *                  `x-claudish-recovery: 1`. Claude Code re-POSTs, rejoins the
 *                  same episode, and the turn survives.
 *   no lease     → **400 `connection_error`**, byte-identical to the pre-recovery
 *                  behaviour, including the type `probe-live.ts` keys off.
 *
 * The rule underneath: *a retryable status is permissible exactly while
 * claudish still has a surface on which the reason is legible.* Answer 503 with
 * no banner and the user gets "API error · Retrying" with the reason nowhere —
 * strictly worse than the bug this feature removes.
 *
 * ── WHY THE CHAIN ASSERTIONS ARE THE EXPENSIVE ONES ─────────────────────────
 *
 * A 503 crossing `FallbackHandler` must not advance the chain: during an outage
 * the next candidate is unreachable for the same reason, and per the standing
 * CLAUDE.md invariant, advancing off a `SUBSCRIPTION_PROVIDERS` candidate onto a
 * metered one quotes the user a real per-token price. `isRetryableError` has no
 * 503 branch, but its FIRST statement is a status-agnostic phrase match whose
 * list contains the bare substring `"quota"` — so a 503 whose MESSAGE mentioned
 * one would have advanced. That is why the guarantee is a marker header rather
 * than a wording rule, and why one test below deliberately builds a 503 message
 * containing the word "quota" and proves the chain still holds. A wording-based
 * fix fails that test; this one passes it.
 *
 * ── ON SETUP FIDELITY ───────────────────────────────────────────────────────
 *
 * Every assertion drives the real `ComposedHandler.handle()` through its real
 * fetch catch, the real ladder and the real coordinator. Only three things are
 * substituted, each at a seam production already has: the clock (injected, so a
 * 270-second deadline costs no real time), `globalThis.fetch` (restored in
 * `afterEach`), and the UI hooks (`registerRecoveryUi`, the same call
 * `installRecoveryUi` makes). No `mock.module()` — Bun's registry bleeds those
 * into sibling test files.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Context } from "hono";
import { resetRecoveryClock, setRecoveryClock } from "../recovery/clock.js";
import {
  type RecoveryUiHooks,
  closeAllEpisodes,
  describeEpisode,
  registerRecoveryUi,
  renderableEpisodeFrame,
} from "../recovery/coordinator.js";
import { retryWatchdogEnv } from "../recovery/settings.js";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { FakeClock, advanceUntilSettled } from "../recovery/test-helpers/fake-clock.js";
import { ComposedHandler } from "./composed-handler.js";
import { FallbackHandler, isRetryableError } from "./fallback-handler.js";
import { buildRecoveryHoldMessage, formatHoldDuration } from "./shared/connection-error.js";
import { hasQuotaExhaustionWording } from "./shared/quota-exhaustion.js";
import { RECOVERY_MARKER_HEADER, isRecoveryHoldResponse } from "./shared/recovery-marker.js";
import type { ModelHandler } from "./types.js";

// ───────────────────────────────────────────────────────────────────────────
// Fixture — PROVOKED, never hand-written
// ───────────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let CONNECT_FAILURE: unknown;

beforeAll(async () => {
  // Bun's fetch uses neither Node's errno names nor `.cause`; it throws a flat
  // TypeError carrying its own `code`. A hand-written `{ code: "ECONNREFUSED" }`
  // would test the classifier's table rather than the runtime's behaviour.
  try {
    await realFetch("http://127.0.0.1:1/refused-on-purpose");
    throw new Error("127.0.0.1:1 accepted a connection — this fixture needs a closed port");
  } catch (e) {
    CONNECT_FAILURE = e;
  }
  expect((CONNECT_FAILURE as { code?: string }).code).toBe("ConnectionRefused");
});

// ───────────────────────────────────────────────────────────────────────────
// Harness
// ───────────────────────────────────────────────────────────────────────────

let clock: FakeClock;

/**
 * A lease that answers for whichever episode is live, switchable mid-test.
 *
 * Registered through `registerRecoveryUi` — the exact call `installRecoveryUi`
 * makes in production — so `composed-handler` reads the lease through the same
 * `uiLeaseValid` indirection it uses with a real pane attached. What is NOT
 * covered here is magmux-ui's own heartbeat accounting; that has its own file
 * (`recovery/lease.test.ts`), and pretending otherwise here would test the
 * double rather than the seam.
 */
let leaseAnswer = false;
const leasedEpisodeIds: string[] = [];
const hooks: RecoveryUiHooks = {
  onEpisodeOpened: (episodeId) => {
    leasedEpisodeIds.push(episodeId);
  },
  onEpisodeClosed: () => {},
  leaseValid: () => leaseAnswer,
};

beforeEach(() => {
  clock = new FakeClock(0);
  setRecoveryClock(clock);
  leaseAnswer = false;
  leasedEpisodeIds.length = 0;
  registerRecoveryUi(hooks);
});

afterEach(() => {
  registerRecoveryUi(null);
  closeAllEpisodes();
  resetRecoveryClock();
  globalThis.fetch = realFetch;
});

/** Every outbound fetch fails the way a dead socket does. */
function breakTheNetwork(): void {
  globalThis.fetch = (async () => {
    throw CONNECT_FAILURE;
  }) as unknown as typeof fetch;
}

interface ProbeOptions {
  name?: string;
  displayName?: string;
  endpoint?: string;
}

function makeTransport(opts: ProbeOptions = {}) {
  return {
    // Unique per handler by default: the episode key is `${provider}|${host}`,
    // and two tests sharing one key would share an episode.
    name: opts.name ?? `probe-${Math.random().toString(36).slice(2)}`,
    displayName: opts.displayName ?? "Held Probe",
    streamFormat: "openai-sse",
    getEndpoint: () => opts.endpoint ?? "http://127.0.0.1:1/v1/chat/completions",
    getHeaders: async () => ({}),
  } as unknown as Parameters<typeof makeHandler>[0];
}

function makeHandler(transport: unknown): ComposedHandler {
  return new ComposedHandler(transport as never, "held-model", "held-model", 8080, {});
}

const PAYLOAD = {
  model: "held-model",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

/**
 * A Context carrying a REAL `Request`, because two of the properties under test
 * are keyed on one: the inbound deadline anchor (a `WeakMap` on `c.req.raw`) and
 * the client-disconnect signal. A context without one silently gets a fresh
 * anchor per read, which would make the rejoin test pass for the wrong reason.
 */
function makeContext(): { c: Context; jsonCalls: number } {
  const state = { jsonCalls: 0 };
  const raw = new Request("http://127.0.0.1:8080/v1/messages", { method: "POST" });
  const c = {
    req: { raw, header: () => undefined },
    header: () => {},
    body: (body: BodyInit | null, init?: ResponseInit) => new Response(body, init),
    json: (body: unknown, status?: number) => {
      state.jsonCalls++;
      return new Response(JSON.stringify(body), { status: status ?? 200 });
    },
  } as unknown as Context;
  return {
    c,
    get jsonCalls() {
      return state.jsonCalls;
    },
  } as { c: Context; jsonCalls: number };
}

/** Run one held request to exhaustion on the fake clock. */
async function runToExhaustion(handler: ComposedHandler, c: Context): Promise<Response> {
  return advanceUntilSettled(clock, handler.handle(c, PAYLOAD), 400_000);
}

async function bodyOf(response: Response): Promise<{
  type?: string;
  error?: { type?: string; message?: string };
}> {
  return JSON.parse(await response.clone().text());
}

// ───────────────────────────────────────────────────────────────────────────
// The flip itself — C-18's unit half
// ───────────────────────────────────────────────────────────────────────────

describe("C-18 — exhaustion with the lease HELD answers 503, not 400", () => {
  test("503 overloaded_error, x-should-retry and the recovery marker", async () => {
    breakTheNetwork();
    leaseAnswer = true;
    const response = await runToExhaustion(makeHandler(makeTransport()), makeContext().c);

    expect(response.status).toBe(503);
    expect(response.headers.get("x-should-retry")).toBe("true");
    expect(response.headers.get(RECOVERY_MARKER_HEADER)).toBe("1");
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await bodyOf(response);
    expect(body.type).toBe("error");
    expect(body.error?.type).toBe("overloaded_error");

    // The surface was ASKED for, through the same hook `installRecoveryUi`
    // registers. A 503 granted by a lease nobody ever requested a pane for
    // would be the forbidden state.
    expect(leasedEpisodeIds).toHaveLength(1);
  });

  test("the message is the SAME sentence the 400 carries, plus a recovery clause", async () => {
    breakTheNetwork();
    leaseAnswer = true;
    const held = await runToExhaustion(makeHandler(makeTransport()), makeContext().c);

    leaseAnswer = false;
    const inline = await runToExhaustion(makeHandler(makeTransport()), makeContext().c);

    const heldMsg = (await bodyOf(held)).error?.message ?? "";
    const inlineMsg = (await bodyOf(inline)).error?.message ?? "";

    // One fault, one sentence. If these two ever diverge the user is being told
    // two different stories about the same failure.
    expect(heldMsg.startsWith(inlineMsg)).toBe(true);
    expect(heldMsg).toContain("claudish retried");
    expect(heldMsg).toContain("still trying, watch the recovery pane");
    // The clause names BOTH numbers the criterion asks for: how many attempts,
    // and how long.
    expect(heldMsg).toMatch(/claudish retried \d+× over (\d+m )?\d+s without reaching it/);
  });

  test("the 503 arm does not go through c.json — the Hono context is never mutated", async () => {
    breakTheNetwork();
    leaseAnswer = true;
    const ctx = makeContext();
    const response = await runToExhaustion(makeHandler(makeTransport()), ctx.c);

    // `c` is SHARED across every candidate in a chain, so a header set on it
    // rides out on `formatCombinedError`'s terminal 400 — a 400 telling Claude
    // Code to retry it, which is the buried-reason failure the whole doctrine
    // exists to prevent. A standalone Response cannot do that.
    expect(response.status).toBe(503);
    expect(ctx.jsonCalls).toBe(0);
  });
});

describe("no lease — today's 400, byte for byte", () => {
  test("400 connection_error, no marker, no x-should-retry", async () => {
    breakTheNetwork();
    leaseAnswer = false;
    const response = await runToExhaustion(makeHandler(makeTransport()), makeContext().c);

    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    // `probe-live.ts` classifies on the TYPE, not the status. Changing it would
    // silently reclassify every unreachable provider in the config TUI.
    expect(body.error?.type).toBe("connection_error");
    expect(response.headers.get(RECOVERY_MARKER_HEADER)).toBeNull();
    expect(response.headers.get("x-should-retry")).toBeNull();
    expect(body.error?.message).not.toContain("claudish retried");
  });

  test("a lease that THROWS reads as no surface, never as yes", async () => {
    breakTheNetwork();
    registerRecoveryUi({
      onEpisodeOpened: () => {},
      onEpisodeClosed: () => {},
      leaseValid: () => {
        throw new Error("the pane process died mid-probe");
      },
    });
    const response = await runToExhaustion(makeHandler(makeTransport()), makeContext().c);

    // The asymmetry is the point: false costs a legible inline error, true
    // costs the turn.
    expect(response.status).toBe(400);
  });
});

describe("[q] give up is 400 even with a live lease", () => {
  test("the give-up key is not turned into a no-op by the lease", async () => {
    breakTheNetwork();
    leaseAnswer = true;
    const handler = makeHandler(makeTransport());
    const { c } = makeContext();
    const inFlight = handler.handle(c, PAYLOAD);

    // Let the episode open and park, then press give-up the way the pane does.
    await advanceUntilSettled(clock, Promise.resolve(), 1);
    await clock.advance(100);
    const frame = renderableEpisodeFrame();
    expect(frame).not.toBeNull();
    const { giveUp } = await import("../recovery/coordinator.js");
    giveUp((frame as { episodeId: string }).episodeId);

    const response = await advanceUntilSettled(clock, inFlight, 400_000);

    // The pane that took the keystroke is by definition alive, so the lease is
    // valid at this instant. A lease-only test would answer 503, Claude Code
    // would immediately re-ask, and "give up" would do nothing at all.
    expect(leaseAnswer).toBe(true);
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error?.type).toBe("connection_error");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C-12 — the chain does not advance. THE ONE THAT COSTS MONEY.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Run `first` as candidate 1 of a two-candidate chain and report whether
 * candidate 2 — the metered provider a subscription user gets silently moved
 * onto — was ever reached.
 */
async function runInChain(
  first: ModelHandler,
  opts: { firstName?: string } = {}
): Promise<{ status: number; advanced: boolean; response: Response }> {
  let advanced = false;
  const second: ModelHandler = {
    async handle() {
      advanced = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  } as unknown as ModelHandler;

  const chain = new FallbackHandler([
    { name: opts.firstName ?? "Held Probe", handler: first },
    { name: "Metered Fallback", handler: second },
  ]);
  const { c } = makeContext();
  const response = await advanceUntilSettled(clock, chain.handle(c, PAYLOAD), 400_000);
  return { status: response.status, advanced, response };
}

describe("C-12 — a recovery 503 does not advance the fallback chain", () => {
  test("ABSENCE: no `trying next provider`, and candidate 2 is never reached", async () => {
    startLogCapture();
    try {
      breakTheNetwork();
      leaseAnswer = true;
      const outcome = await runInChain(makeHandler(makeTransport()));

      expect(outcome.advanced).toBe(false);
      expect(outcome.status).toBe(503);
      expect(isRecoveryHoldResponse(outcome.response)).toBe(true);

      const lines = await capturedLines();
      // The literal string C-12 names. Asserted as an ABSENCE, because a test
      // that only checked the status would pass against the bug.
      expect(lines.some((l) => l.includes("trying next provider"))).toBe(false);
    } finally {
      stopLogCapture();
    }
  });

  test("STRUCTURAL: a 503 whose message contains the word `quota` still holds the chain", async () => {
    startLogCapture();
    try {
      breakTheNetwork();
      leaseAnswer = true;
      // A provider whose own display name carries the word. Nothing exotic —
      // the sentence is built from the provider and endpoint the user
      // configured, so a vendor called "Quota Cloud" produces this for free.
      const handler = makeHandler(makeTransport({ displayName: "Quota Cloud" }));
      const outcome = await runInChain(handler, { firstName: "Quota Cloud" });

      // FIRST prove the hazard is real on this very body: the phrase match that
      // runs first inside `isRetryableError` DOES fire on it.
      const message = (await bodyOf(outcome.response)).error?.message ?? "";
      expect(message.toLowerCase()).toContain("quota");
      expect(hasQuotaExhaustionWording(message)).toBe(true);

      // And the chain still does not move. A wording-based fix fails here.
      expect(outcome.advanced).toBe(false);
      expect(outcome.status).toBe(503);

      const lines = await capturedLines();
      expect(lines.some((l) => l.includes("trying next provider"))).toBe(false);
      // Nor the quieter advance, which is the same event with a cost warning.
      expect(lines.some((l) => l.includes("falling through to the next provider"))).toBe(false);
    } finally {
      stopLogCapture();
    }
  });

  test("the 503 the SHIPPED wording produces does not trip the phrase list", async () => {
    // The belt behind the marker's brace. The marker is what makes chain-safety
    // structural; this keeps the default sentence from relying on it.
    const msg = buildRecoveryHoldMessage(
      "Cannot reach Openai-codex at https://chatgpt.com/backend-api/codex/responses. " +
        "Check your network connection.",
      7,
      225_000
    );
    expect(hasQuotaExhaustionWording(msg)).toBe(false);
    expect(msg).toContain("claudish retried 7× over 3m 45s without reaching it");
  });
});

describe("exhaustedChainStatus cannot fold a recovery 503 into a terminal 400", () => {
  test("an EARLIER candidate's retryable auth failure does not demote our 503", async () => {
    breakTheNetwork();
    leaseAnswer = true;

    // Candidate 1 fails 401 — retryable, so the chain advances and pushes an
    // error that is NOT transient. Candidate 2 is the held one. Without the
    // verbatim return, `formatCombinedError` would run `exhaustedChainStatus`
    // over [401, 503], find one non-transient, and answer a terminal 400 —
    // Claude Code would never re-POST and tier 2 would never begin.
    const authFailure: ModelHandler = {
      async handle() {
        return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
          status: 401,
        });
      },
    } as unknown as ModelHandler;

    const chain = new FallbackHandler([
      { name: "Revoked Key", handler: authFailure },
      { name: "Held Probe", handler: makeHandler(makeTransport()) },
    ]);
    const { c } = makeContext();
    const response = await advanceUntilSettled(clock, chain.handle(c, PAYLOAD), 400_000);

    expect(response.status).toBe(503);
    expect(response.headers.get(RECOVERY_MARKER_HEADER)).toBe("1");
    expect(response.headers.get("x-should-retry")).toBe("true");
    const body = await bodyOf(response);
    // Not `all_providers_failed`, which is what a combined error would say.
    expect(body.error?.type).toBe("overloaded_error");
  });
});

describe("the marker is checked before the phrase list, inside isRetryableError too", () => {
  const { CONNECTION_FAULT_HEADER, RECOVERY_MARKER_VALUE } = require("./shared/recovery-marker.js");
  const quotaBody = JSON.stringify({ error: { message: "You have exceeded your quota" } });
  const marked = new Headers({ [RECOVERY_MARKER_HEADER]: "1" });

  test("without the marker the phrase list wins — the hazard, demonstrated", () => {
    expect(isRetryableError(503, quotaBody, "Held Probe")).toBe(true);
  });

  test("with the marker the answer is false, so the ordering is the guarantee", () => {
    expect(isRetryableError(503, quotaBody, "Held Probe", marked)).toBe(false);
  });

  test("the marker also beats the statuses that are otherwise retryable", () => {
    for (const status of [401, 402, 403, 404, 429, 502, 503, 504]) {
      expect(isRetryableError(status, "{}", "Held Probe", marked)).toBe(false);
      expect(isRetryableError(status, "{}", "Held Probe")).toBe(true);
    }
  });

  test("the connection-fault marker also blocks an unavailable endpoint", () => {
    const headers = new Headers({ [CONNECTION_FAULT_HEADER]: RECOVERY_MARKER_VALUE });
    expect(isRetryableError(503, "{}", "x", headers)).toBe(false);
  });

  test("a wrong value is not the marker", () => {
    expect(isRetryableError(401, "{}", "x", new Headers({ [RECOVERY_MARKER_HEADER]: "0" }))).toBe(
      true
    );
    expect(isRetryableError(401, "{}", "x", new Headers())).toBe(true);
  });
});

describe("the marker's wire name is a contract, not an implementation detail", () => {
  test("the literal header name, pinned where a rename cannot move both sides together", () => {
    // `recovery-marker.ts` mints it and `fallback-handler.ts` reads it, and both
    // import the constant — so renaming the constant moves both sides at once
    // and no behavioural test notices. The name is on the wire between a
    // response and the handler that decides whether to spend the user's money;
    // pin the string itself.
    expect(RECOVERY_MARKER_HEADER).toBe("x-claudish-recovery");
  });

  test("the 503 carries that literal name, read off the response with no constant", async () => {
    breakTheNetwork();
    leaseAnswer = true;
    const response = await runToExhaustion(makeHandler(makeTransport()), makeContext().c);
    expect(response.headers.get("x-claudish-recovery")).toBe("1");
  });
});

describe("the marker cannot be forged by an upstream provider", () => {
  test("an upstream error response is rebuilt, so its headers never reach the chain", async () => {
    // The general property, asserted on the response the client receives: an
    // upstream's headers do not survive `ComposedHandler`'s non-ok exits. This
    // is what makes "cannot be forged" structural rather than a claim about one
    // status code.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "upstream is busy" } }), {
        status: 503,
        headers: { [RECOVERY_MARKER_HEADER]: "1", "x-should-retry": "true" },
      })) as unknown as typeof fetch;

    const response = await makeHandler(makeTransport()).handle(makeContext().c, PAYLOAD);

    expect(response.status).toBe(503);
    expect(response.headers.get(RECOVERY_MARKER_HEADER)).toBeNull();
    expect(isRecoveryHoldResponse(response)).toBe(false);
  });

  test("an upstream 401 carrying the header still advances the chain", async () => {
    // The discriminating shape. If ComposedHandler ever copied upstream headers
    // onto a non-ok response, a hostile or merely eccentric provider could pin
    // every user to itself by emitting this header — and the chain would stop
    // where it should advance. It must NOT be observable.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        headers: { [RECOVERY_MARKER_HEADER]: "1", "x-should-retry": "true" },
      })) as unknown as typeof fetch;

    const outcome = await runInChain(makeHandler(makeTransport()));

    expect(outcome.advanced).toBe(true);
    expect(isRecoveryHoldResponse(outcome.response)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C-6's tier-2 half — one episode across the handoff
// ───────────────────────────────────────────────────────────────────────────

describe("the client's re-POST rejoins the SAME episode", () => {
  test("same episode id, clientRetries++, tier 2, ladder NOT reset", async () => {
    breakTheNetwork();
    leaseAnswer = true;
    const transport = makeTransport({ name: "rejoin-probe" });

    const first = await runToExhaustion(makeHandler(transport), makeContext().c);
    expect(first.status).toBe(503);

    const afterHandoff = renderableEpisodeFrame();
    expect(afterHandoff?.state).toBe("handoff");
    const episodeId = afterHandoff?.episodeId as string;
    const attemptsAfterTier1 = afterHandoff?.attempts as number;
    const ladderAfterTier1 = describeEpisode(episodeId)?.ladderIndex as number;
    expect(attemptsAfterTier1).toBeGreaterThan(1);

    // Claude Code's own backoff, measured at ≤38.4 s and honoured verbatim —
    // comfortably inside EPISODE_GRACE_MS, which is why the episode is still
    // there to rejoin.
    await clock.advance(10_000);

    // The re-POST. A NEW inbound request, so it gets a fresh per-request
    // deadline — the deadline belongs to the socket and the socket is new.
    const second = await runToExhaustion(makeHandler(transport), makeContext().c);
    expect(second.status).toBe(503);

    const rejoined = renderableEpisodeFrame();
    // ONE episode id across both tiers: one banner, one attempt counter.
    expect(rejoined?.episodeId).toBe(episodeId);
    expect(rejoined?.clientRetries).toBe(1);
    expect(rejoined?.tier).toBe(2);
    // The counters continue rather than restarting, which is what makes the
    // pane read as one continuous recovery.
    expect(rejoined?.attempts).toBeGreaterThan(attemptsAfterTier1);
    // And the ladder resumes where it left off instead of dropping back to 5 s
    // — a reset would hammer a dead host harder the longer the outage lasted.
    expect(describeEpisode(episodeId)?.ladderIndex).toBeGreaterThanOrEqual(ladderAfterTier1);
  });

  test("the turn completes on the client's re-POST, and the banner stops at once", async () => {
    startLogCapture();
    try {
      await recoversAfterHandoff();
    } finally {
      stopLogCapture();
    }
  });

  async function recoversAfterHandoff(): Promise<void> {
    breakTheNetwork();
    leaseAnswer = true;
    const transport = makeTransport({ name: "recover-after-handoff" });

    const first = await runToExhaustion(makeHandler(transport), makeContext().c);
    expect(first.status).toBe(503);
    const episodeId = renderableEpisodeFrame()?.episodeId as string;
    expect(describeEpisode(episodeId)?.state).toBe("handoff");

    await clock.advance(5_000);

    // The network comes back AFTER the handoff. This is C-6's second run in
    // miniature: the proof that the two tiers are one episode is that the turn
    // completes, not that the banner looked continuous.
    // A real `openai-sse` body, which is what this transport declares and what
    // the handler's parser expects. A JSON completion would be parsed as an
    // empty stream and the assertion would pass or fail for reasons that have
    // nothing to do with recovery.
    const sse =
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "back" } }],
      })}\n\n` +
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n` +
      "data: [DONE]\n\n";
    globalThis.fetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const second = await runToExhaustion(makeHandler(transport), makeContext().c);

    expect(second.status).toBe(200);
    const text = await second.clone().text();
    expect(text).toContain("back");

    // ── THE PART THAT IS NOT OBVIOUS ────────────────────────────────────────
    //
    // The re-POST did NOT rejoin the episode. Its first attempt is the
    // handler's byte-identical primary fetch, which runs before the coordinator
    // sees the request — and with the network back it simply succeeded. Nothing
    // in the ladder ever ran.
    //
    // So the episode has to be closed by the SUCCESS, not by a rejoin. Left to
    // the grace timer it would sit in `handoff` for two more minutes with the
    // pane painting "waiting for Claude Code to retry" over a working session.
    expect(describeEpisode(episodeId)).toBeNull();
    expect(renderableEpisodeFrame()).toBeNull();

    const lines = await capturedLines();
    expect(lines.some((l) => l.includes("answered on the client's own retry"))).toBe(true);
    expect(lines.some((l) => l.includes(`episode ${episodeId} closed: recovered`))).toBe(true);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// The client's retry budget
// ───────────────────────────────────────────────────────────────────────────

describe("CLAUDE_CODE_RETRY_WATCHDOG needs all three gates", () => {
  const UI = "CLAUDISH_RECOVERY_UI";
  const ON = "CLAUDISH_RECOVERY";
  let savedUi: string | undefined;
  let savedOn: string | undefined;

  beforeEach(() => {
    savedUi = process.env[UI];
    savedOn = process.env[ON];
  });

  afterEach(() => {
    if (savedUi === undefined) delete process.env[UI];
    else process.env[UI] = savedUi;
    if (savedOn === undefined) delete process.env[ON];
    else process.env[ON] = savedOn;
  });

  test("set when the UI is enabled and a pane is reachable — the reach is ~a day", () => {
    delete process.env[UI];
    delete process.env[ON];
    expect(retryWatchdogEnv({ paneEligible: true })).toEqual({ CLAUDE_CODE_RETRY_WATCHDOG: "1" });
  });

  test("absent when the user turned the UI off", () => {
    // No pane means no lease means an inline 400 at exhaustion means nothing to
    // hand back — so extending the client's budget would buy only the side
    // effect on claudish's other 503s.
    delete process.env[ON];
    process.env[UI] = "0";
    expect(retryWatchdogEnv({ paneEligible: true })).toEqual({});
    expect("CLAUDE_CODE_RETRY_WATCHDOG" in retryWatchdogEnv({ paneEligible: true })).toBe(false);
  });

  test("absent when THIS LAUNCH can never obtain a pane — `-p`, no TTY, no magmux", () => {
    // The gate that was missing. Those launches cannot hold the lease a
    // recovery 503 requires, so the watchdog would apply the accepted
    // duplicate-request exposure to every UNRELATED 503 the session sees and
    // return nothing for it: ~300 attempts on an upstream overload, for hours,
    // in exactly the configurations that opted out.
    delete process.env[UI];
    delete process.env[ON];
    expect(retryWatchdogEnv({ paneEligible: false })).toEqual({});
  });

  test("absent under --no-recovery, however the UI is configured", () => {
    // RISK-7's promise is that `--no-recovery` restores pre-recovery behaviour
    // byte for byte. A ladder that never runs hands nothing back, so a client
    // looping 300 times is pure cost — and CI is where this switch lives.
    process.env[ON] = "0";
    delete process.env[UI];
    expect(retryWatchdogEnv({ paneEligible: true })).toEqual({});
    process.env[UI] = "1";
    expect(retryWatchdogEnv({ paneEligible: true })).toEqual({});
  });
});

describe("formatHoldDuration", () => {
  test("minutes appear only when there are minutes, and it never goes negative", () => {
    expect(formatHoldDuration(0)).toBe("0s");
    expect(formatHoldDuration(-5_000)).toBe("0s");
    expect(formatHoldDuration(45_000)).toBe("45s");
    expect(formatHoldDuration(225_000)).toBe("3m 45s");
    expect(formatHoldDuration(120_000)).toBe("2m 0s");
  });
});
