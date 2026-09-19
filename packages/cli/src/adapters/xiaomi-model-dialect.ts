/**
 * XiaomiModelDialect — Layer 2 dialect for Xiaomi (MiMo) models.
 *
 * Handles Xiaomi-specific quirks:
 * - 64-char tool name limit (OpenAI standard, strictly enforced by Xiaomi API)
 * - Strips unsupported thinking params
 * - Context window comes dynamically from OpenRouter model catalog
 */

import { log } from "../logger.js";
import { type AdapterResult, BaseAPIFormat, matchesModelFamily } from "./base-api-format.js";

export class XiaomiModelDialect extends BaseAPIFormat {
  processTextContent(textContent: string, _accumulatedText: string): AdapterResult {
    return {
      cleanedText: textContent,
      extractedToolCalls: [],
      wasTransformed: false,
    };
  }

  // The 64-char limit and the truncation call that used to stand here are gone:
  // `BaseAPIFormat.getToolNameLimit()` now returns 64 for every OpenAI-shaped
  // wire, and `prepareRequest`'s template applies it. Xiaomi enforces the limit
  // strictly, which is why this dialect was the only adapter in the tree that
  // ever truncated at all — it is no longer special.

  protected override applyNativeReasoning(request: any, originalRequest: any): any {
    // Xiaomi's own API doesn't support thinking params.
    if (originalRequest.thinking) {
      log("[XiaomiModelDialect] Stripping thinking object (not supported by Xiaomi API)");
      delete request.thinking;
    }

    return request;
  }

  shouldHandle(modelId: string): boolean {
    return matchesModelFamily(modelId, "xiaomi") || matchesModelFamily(modelId, "mimo");
  }

  getName(): string {
    return "XiaomiModelDialect";
  }
}

// Backward-compatible alias
/** @deprecated Use XiaomiModelDialect */
export { XiaomiModelDialect as XiaomiAdapter };
