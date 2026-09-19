/**
 * LiteLLMAPIFormat — Layer 1 wire format for LiteLLM proxy.
 *
 * Handles LiteLLM-specific model transforms:
 * - Inline image conversion for MiniMax (LiteLLM doesn't forward image_url properly)
 * - OpenAI-compatible payload with stream_options and tool_choice
 */

import { mapToolChoiceToOpenAI } from "../handlers/shared/format/openai-tools.js";
import { log } from "../logger.js";
import { DefaultAPIFormat } from "./base-api-format.js";

/** Models needing image_url → inline base64 conversion */
const INLINE_IMAGE_MODEL_PATTERNS = ["minimax"];

export class LiteLLMAPIFormat extends DefaultAPIFormat {
  private visionSupported: boolean;
  private needsInlineImages: boolean;

  // baseUrl is accepted for backwards-compatible call sites (provider-profiles,
  // custom-endpoints-loader, tests) but no longer consulted — the cached
  // catalog read this fed has been removed.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(modelId: string, _baseUrl: string) {
    super(modelId);
    this.visionSupported = this.checkVisionSupport();
    this.needsInlineImages = INLINE_IMAGE_MODEL_PATTERNS.some((p) =>
      modelId.toLowerCase().includes(p)
    );
  }

  getName(): string {
    return "LiteLLMAPIFormat";
  }

  shouldHandle(_modelId: string): boolean {
    return false; // Always used explicitly, not via DialectManager matching
  }

  supportsVision(): boolean {
    return this.visionSupported;
  }

  /**
   * Convert messages, then transform image_url blocks to inline base64 text
   * for models where LiteLLM doesn't properly forward image content.
   */
  convertMessages(claudeRequest: any, filterIdentityFn?: (s: string) => string): any[] {
    const messages = super.convertMessages(claudeRequest, filterIdentityFn);

    if (!this.needsInlineImages) return messages;

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;

      const newContent: any[] = [];
      let inlineImages = "";

      for (const part of msg.content) {
        if (part.type === "image_url") {
          const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
          if (url?.startsWith("data:")) {
            const base64Match = url.match(/^data:[^;]+;base64,(.+)$/);
            if (base64Match) {
              inlineImages += `\n[Image base64:${base64Match[1]}]`;
              log(`[LiteLLMAPIFormat] Converted image_url to inline base64 for ${this.modelId}`);
            }
          } else if (url) {
            inlineImages += `\n[Image URL: ${url}]`;
          }
        } else {
          newContent.push(part);
        }
      }

      if (inlineImages) {
        const lastText = newContent.findLast((p: any) => p.type === "text");
        if (lastText) {
          lastText.text += inlineImages;
        } else {
          newContent.push({ type: "text", text: inlineImages.trim() });
        }
      }

      if (newContent.length === 1 && newContent[0].type === "text") {
        msg.content = newContent[0].text;
      } else if (newContent.length > 0) {
        msg.content = newContent;
      }
    }

    return messages;
  }

  /**
   * Build LiteLLM-specific request payload.
   * Standard OpenAI format with stream_options and tool_choice support.
   */
  buildPayload(claudeRequest: any, messages: any[], tools: any[]): any {
    const payload: any = {
      model: this.modelId,
      messages,
      temperature: claudeRequest.temperature ?? 1,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: claudeRequest.max_tokens,
    };

    if (tools.length > 0) {
      payload.tools = tools;
    }

    const toolChoice = mapToolChoiceToOpenAI(claudeRequest.tool_choice);
    if (toolChoice !== undefined) {
      payload.tool_choice = toolChoice;
    }

    this.applyOpenAISamplingParams(payload, claudeRequest);

    return payload;
  }

  private checkVisionSupport(): boolean {
    // Vision support data is no longer cached locally — claudish doesn't fetch
    // LiteLLM's catalog (per the Firebase-only catalog rule). Default to true
    // and let LiteLLM 4xx if the model can't actually do vision; a server-side
    // error is more informative than a stale local guess.
    return true;
  }
}

// Backward-compatible alias
/** @deprecated Use LiteLLMAPIFormat */
export { LiteLLMAPIFormat as LiteLLMAdapter };
