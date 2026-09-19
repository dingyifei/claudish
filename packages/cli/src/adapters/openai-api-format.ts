/**
 * OpenAIAPIFormat — Layer 1 wire format for OpenAI Chat Completions API.
 *
 * Handles:
 * - Context window detection for OpenAI models (gpt-*, o1, o3, codex)
 * - Mapping 'thinking.budget_tokens' to 'reasoning_effort' for o1/o3 models
 * - max_completion_tokens vs max_tokens for newer models
 * - Codex Responses API message conversion and payload building
 * - Tool choice mapping
 *
 * Also serves as Layer 2 ModelDialect for OpenAI-native models (o1/o3 reasoning params).
 */

import { mapToolChoiceToOpenAI } from "../handlers/shared/format/openai-tools.js";
import { log } from "../logger.js";
import type { StreamFormat } from "../providers/transport/types.js";
import { type AdapterResult, BaseAPIFormat, type EffortLevel } from "./base-api-format.js";
import { lookupModelReasoning, lookupModelTokenParam } from "./model-catalog.js";

export class OpenAIAPIFormat extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  override getStreamFormat(): StreamFormat {
    return "openai-sse";
  }

  /**
   * OpenAI's Chat Completions API hard-caps the tools array at 128. Exceeding
   * it fails the whole request with HTTP 400 "Invalid 'tools': array too long".
   * (Note: CodexAPIFormat is a separate class and is intentionally NOT capped
   * here — the Responses API path keeps its own behavior.)
   */
  override getMaxToolCount(): number | null {
    return 128;
  }

  // Tool-name encoding used to live here, and here ONLY, which is why no other
  // OpenAI-shaped adapter did it. It is now in `prepareRequest`'s template, so
  // this hook has nothing left to do.

  /**
   * OpenAI's own reasoning knob. Not called on the Anthropic wire.
   */
  protected override applyNativeReasoning(request: any, originalRequest: any): any {
    // Map Claude Code's effort (output_config.effort, or legacy
    // thinking.budget_tokens) → OpenAI reasoning_effort for reasoning-capable
    // models. Only set it if buildPayload hasn't already (it builds the payload
    // first; this covers paths that call prepareRequest on a payload built
    // elsewhere). Always strip a leftover `thinking` block — OpenAI rejects it.
    if (this.supportsReasoningEffort() && request.reasoning_effort === undefined) {
      const effort = this.resolveReasoningEffort(originalRequest);
      if (effort) {
        request.reasoning_effort = effort;
        log(`[OpenAIAPIFormat] reasoning_effort -> ${effort} for ${this.modelId}`);
      }
    }
    if (request.thinking) delete request.thinking;

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return modelId.startsWith("oai/") || modelId.includes("o1") || modelId.includes("o3");
  }

  getName(): string {
    return "OpenAIAPIFormat";
  }

  // ─── ComposedHandler integration ───────────────────────────────────

  override buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    return this.buildChatCompletionsPayload(claudeRequest, messages, tools);
  }

  // ─── Private helpers ───────────────────────────────────────────────

  /**
   * Whether this model accepts OpenAI's `reasoning_effort` parameter. Covers the
   * o-series (o1/o3/o4) AND the gpt-5 family — gpt-5/gpt-5.x take reasoning_effort
   * too, which the older o1/o3-only gate missed (so effort was silently dropped
   * for gpt-5.5). Sakana Fugu (routed through this OpenAI-compatible path) also
   * takes a nested-but-here-top-level reasoning_effort.
   *
   * STRIP exceptions (the param 400s or doesn't exist):
   *  - `o1-mini`: the only o-series model with NO reasoning_effort param at all.
   */
  private supportsReasoningEffort(): boolean {
    // CATALOG FIRST. The name rule below is a cold-cache fallback only.
    //
    // Measured against the live catalog, the name rule is wrong in both
    // directions: 60 models take reasoning_effort but do not match it (every
    // fugu-*, deepseek-v4-*, gemini-3-flash-agent, claude-*-fast), so effort was
    // silently dropped; and 14 models match it but do NOT take the param
    // (gpt-5-image, gpt-5.2-chat, gpt-5.3-chat, …), where sending it can 400.
    // `isSakanaFugu()` below is the fossil of hand-patching one of those 60.
    const reasoning = lookupModelReasoning(this.modelId);
    if (reasoning) return reasoning.supported === true && reasoning.control === "effort";

    const model = this.modelId.toLowerCase();
    // o1-mini is the lone o-series model without the param → strip.
    if (model.includes("o1-mini")) return false;
    return (
      model.includes("o1") ||
      model.includes("o3") ||
      model.includes("o4") ||
      model.includes("gpt-5") ||
      this.isSakanaFugu()
    );
  }

  /** Sakana Fugu (fugu / fugu-ultra / sakana/*) — routed through this OpenAI path. */
  private isSakanaFugu(): boolean {
    const model = this.modelId.toLowerCase();
    return model.startsWith("fugu") || model.startsWith("sakana/") || model.includes("/fugu");
  }

  /** gpt-5.1 and later (5.1/5.2/5.5, and their -codex variants). */
  private isGpt51Plus(): boolean {
    const model = this.modelId.toLowerCase();
    return /gpt-5\.[1-9]/.test(model);
  }

  /** o-series reasoning models (o1/o3/o4) — accept only low|medium|high. */
  private isOSeries(): boolean {
    const model = this.modelId.toLowerCase();
    return model.includes("o1") || model.includes("o3") || model.includes("o4");
  }

  /** Original GPT-5 (gpt-5, gpt-5-mini/nano/pro/codex) — NOT gpt-5.1+. */
  private isOriginalGpt5(): boolean {
    const model = this.modelId.toLowerCase();
    return model.includes("gpt-5") && !this.isGpt51Plus();
  }

  /**
   * Whether this model accepts `xhigh`. The original GPT-5 family and the
   * o-series cap at `high` — sending `xhigh` 400s, so those clamp down. The
   * gpt-5.1+ family DOES accept `xhigh` (verified against the live API for
   * gpt-5.5 — see reasoning-effort.test.ts). gpt-5.1-codex-max is the documented
   * minimum, but the pinned test asserts the broader gpt-5.1+ acceptance.
   */
  private acceptsXhigh(): boolean {
    return this.isGpt51Plus() || this.isSakanaFugu();
  }

  /**
   * Map Claude Code's effort signal to a valid OpenAI `reasoning_effort` value.
   *
   * Modern Claude Code (Opus 4.7/4.8) sends `output_config.effort` as a string
   * level (none/minimal/low/medium/high/xhigh/max). Older clients sent
   * `thinking.budget_tokens` (a number) — kept as a fallback.
   *
   * Normalization to a canonical level is delegated to the shared
   * resolveEffortLevel(); this method then clamps that level to the value set
   * the SPECIFIC model accepts (OpenAI's gates differ sharply per family).
   *
   * OpenAI's accepted set is `none | minimal | low | medium | high | xhigh`
   * (`max` is rejected — `xhigh` is the ceiling; `minimal` is rejected on
   * gpt-5.1+). Sakana Fugu accepts ONLY `high | xhigh` (everything below 400s),
   * so its values clamp UP. Returns undefined when there's no effort signal.
   */
  private resolveReasoningEffort(claudeRequest: any): string | undefined {
    // Legacy budget bucketing is pinned by reasoning-effort.test.ts (gpt-5.x:
    // <16000→low, >=32000→high, else medium) — keep it here rather than via the
    // shared resolver, whose buckets differ. The string-level path delegates to
    // the shared normalizer.
    const rawLevel = claudeRequest?.output_config?.effort;
    let level: EffortLevel | undefined;
    if (typeof rawLevel === "string") {
      level = this.resolveEffortLevel(claudeRequest);
      if (!level) return undefined; // unknown string → let OpenAI default
    } else {
      const budget = claudeRequest?.thinking?.budget_tokens;
      if (typeof budget !== "number") return undefined;
      level = budget < 16000 ? "low" : budget >= 32000 ? "high" : "medium";
    }

    // Sakana Fugu: ONLY high|xhigh valid; clamp everything below UP to high.
    // Applied only on a cold cache — when the catalog is available it already
    // says `efforts: ["xhigh","high"]`, and clampToVocabulary's upward walk
    // produces the same answer generically (and gets fugu-ultra's `max` right,
    // which this hardcoded pair does not).
    if (this.isSakanaFugu() && !lookupModelReasoning(this.modelId)?.efforts?.length) {
      const value = level === "xhigh" || level === "max" ? "xhigh" : "high";
      log(`[OpenAIAPIFormat] Sakana Fugu clamp ${level} -> ${value} for ${this.modelId}`);
      return value;
    }

    return this.clampOpenAIEffort(level);
  }

  /**
   * Canonical strength ordering, strongest first. Used to walk to the nearest
   * level a model actually advertises. Ordering only — never a per-model list.
   */
  private static readonly EFFORT_LADDER = [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "minimal",
    "none",
  ] as const;

  /**
   * Clamp a requested level to a model's OWN advertised vocabulary.
   *
   * Walks DOWN the ladder from the requested level first (a weaker level is the
   * safe substitution), and only walks UP if the model advertises nothing
   * weaker. That upward walk is what makes Sakana Fugu work without a special
   * case: its vocabulary is `["xhigh","high"]`, so a `low` request finds nothing
   * below and clamps up to `high` — exactly what the hand-written rule did.
   */
  private clampToVocabulary(level: EffortLevel, efforts: string[]): string {
    const allowed = new Set(efforts.map((e) => e.toLowerCase()));
    if (allowed.has(level)) return level;

    const ladder = OpenAIAPIFormat.EFFORT_LADDER;
    const idx = ladder.indexOf(level as (typeof ladder)[number]);
    if (idx === -1) return efforts[0];

    // `none` is NOT merely the weakest level — it turns reasoning off. Falling
    // into it as a substitution silently changes what the model does, so it is
    // only ever returned on an exact match. A model that lacks the requested
    // weak level (e.g. `minimal` on gpt-5.5) gets the next level UP instead.
    for (let i = idx + 1; i < ladder.length; i++) {
      if (ladder[i] !== "none" && allowed.has(ladder[i])) return ladder[i];
    }
    for (let i = idx - 1; i >= 0; i--) {
      if (allowed.has(ladder[i])) return ladder[i];
    }
    return efforts[0];
  }

  /** Clamp a canonical level to the value set the current OpenAI model accepts. */
  private clampOpenAIEffort(level: EffortLevel): string {
    // CATALOG FIRST — the model's own advertised vocabulary. The name ladder
    // below is a cold-cache fallback, and it is measurably wrong in places: it
    // grants `xhigh` to every gpt-5.1+ id, but the catalog says gpt-5.1 accepts
    // only ["high","medium","low","none"].
    const efforts = lookupModelReasoning(this.modelId)?.efforts;
    if (efforts?.length) {
      const value = this.clampToVocabulary(level, efforts);
      if (value !== level) {
        log(`[OpenAIAPIFormat] effort ${level} -> ${value} (catalog) for ${this.modelId}`);
      }
      return value;
    }
    return this.clampOpenAIEffortByName(level);
  }

  /** Cold-cache fallback: the pre-catalog name ladder, unchanged. */
  private clampOpenAIEffortByName(level: EffortLevel): string {
    // `max` never exists on OpenAI — xhigh is the ceiling.
    // `minimal` is rejected on gpt-5.1+ and on the o-series.
    // `none` is valid only on the gpt-5.1+ family.
    // `xhigh` is accepted only on gpt-5.1-codex-max.
    switch (level) {
      case "none":
        // gpt-5.1+ accepts none; o-series → low; original GPT-5 → minimal.
        if (this.isGpt51Plus()) return "none";
        if (this.isOSeries()) return "low";
        if (this.isOriginalGpt5()) return "minimal";
        return "none";
      case "minimal":
        // Rejected on gpt-5.1+ and o-series → low. Valid on original GPT-5.
        if (this.isGpt51Plus() || this.isOSeries()) return "low";
        return "minimal";
      case "low":
      case "medium":
      case "high":
        return level;
      case "xhigh":
        return this.acceptsXhigh() ? "xhigh" : "high";
      case "max":
        // No `max` on OpenAI; ceiling is xhigh (only on codex-max), else high.
        return this.acceptsXhigh() ? "xhigh" : "high";
      default:
        return "medium";
    }
  }

  /**
   * Which output-token parameter this model expects.
   *
   * CATALOG FIRST (`tokenParam`), because the correct answer is not derivable
   * from the name: the gpt-5.6-* family takes `max_output_tokens` while the
   * name rule below says `max_completion_tokens`. The rule also has no way to
   * be right about a model released after it was written.
   */
  private tokenParamName(): string {
    const fromCatalog = lookupModelTokenParam(this.modelId);
    if (fromCatalog) return fromCatalog;

    const model = this.modelId.toLowerCase();
    const usesMaxCompletion =
      model.includes("gpt-5") ||
      model.includes("o1") ||
      model.includes("o3") ||
      model.includes("o4");
    return usesMaxCompletion ? "max_completion_tokens" : "max_tokens";
  }

  private buildChatCompletionsPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      stream_options: { include_usage: true },
    };

    payload[this.tokenParamName()] = claudeRequest.max_tokens;

    if (tools.length > 0) {
      payload.tools = tools;
    }

    const toolChoice = mapToolChoiceToOpenAI(claudeRequest.tool_choice);
    if (toolChoice !== undefined) {
      payload.tool_choice = toolChoice;
    }

    // Map Claude Code's effort (output_config.effort, or legacy
    // thinking.budget_tokens) → OpenAI reasoning_effort for reasoning-capable
    // models (o-series + gpt-5 family).
    if (this.supportsReasoningEffort()) {
      const effort = this.resolveReasoningEffort(claudeRequest);
      if (effort) {
        payload.reasoning_effort = effort;
        log(`[OpenAIAPIFormat] reasoning_effort -> ${effort} for ${this.modelId}`);
      }
    }

    this.applyOpenAISamplingParams(payload, claudeRequest);

    return payload;
  }
}

// Backward-compatible alias
/** @deprecated Use OpenAIAPIFormat */
export { OpenAIAPIFormat as OpenAIAdapter };
