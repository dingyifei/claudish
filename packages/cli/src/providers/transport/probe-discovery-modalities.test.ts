import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiskCacheV3, type SlimModelEntry, writeAllModelsCache } from "../all-models-cache.js";
import {
  _clearChatCapabilityIndex,
  classifyChatCapability,
  isReportedChatCapable,
  unavailableForMissingCapability,
} from "./probe-discovery.js";

const CATALOG_GENERATION_ID = "g-20260920154425586-418ad3dd";

// Trimmed verbatim from the live cloud models catalog generation above. Only
// fields read by classifyChatCapability, plus aliases under test, are retained.
const liveRows: SlimModelEntry[] = [
  {
    modelId: "gpt-5-image",
    aliases: ["openai/gpt-5-image"],
    outputModalities: ["image", "text"],
    videoOutput: false,
  },
  {
    modelId: "gemini-3.1-flash-image",
    aliases: ["google/gemini-3.1-flash-image", "google/flash-image-3.1"],
    outputModalities: ["image", "text"],
    videoOutput: false,
  },
  {
    modelId: "nano-banana-pro",
    aliases: [],
    outputModalities: ["image"],
    supportsVision: true,
  },
  {
    modelId: "qwen-audio-3.0-realtime-plus",
    aliases: [],
    outputModalities: ["audio", "text"],
    videoOutput: false,
    supportsTools: true,
  },
  {
    modelId: "gpt-image-2.5-flare",
    aliases: ["openai/gpt-image-2.5-flare"],
    outputModalities: ["image"],
  },
  {
    modelId: "gemini-omni-1.1-flash",
    aliases: ["google/gemini-omni-1.1-flash"],
    outputModalities: ["video"],
    videoOutput: true,
  },
  {
    modelId: "qwen-audio-3.0-tts-flash",
    aliases: ["qwen/qwen-audio-3.0-tts-flash"],
    outputModalities: ["audio"],
  },
  {
    modelId: "gemini-embedding-2",
    aliases: ["google/gemini-embedding-2", "google/gemini-embedding-2:batch"],
    outputModalities: ["embeddings"],
  },
  {
    modelId: "mai-transcribe-2",
    aliases: ["microsoft/mai-transcribe-2", "MAI-Transcribe-2"],
    outputModalities: ["transcription"],
  },
  {
    modelId: "mai-voice-2",
    aliases: ["microsoft/mai-voice-2", "MAI-Voice-2"],
    outputModalities: ["speech"],
  },
  {
    modelId: "llama-nemotron-rerank-vl-1b-v2",
    aliases: ["nvidia/llama-nemotron-rerank-vl-1b-v2:free"],
    outputModalities: ["rerank"],
  },
  {
    modelId: "jev-1.13",
    aliases: ["typesafe/jev-1.13", "~typesafe/jev-latest", "jev-1.13-free"],
    outputModalities: ["decisions"],
  },
];

// Contract-only rows. Generation g-20260920154425586-418ad3dd has no null or
// empty output list and no videoOutput:true row that also publishes text. The
// agreed precedence is recorded in
// ai-docs/sessions/dev-feature-catalog-phase1-20260921-0015/implementation/modalities.md.
const contractRows: SlimModelEntry[] = [
  {
    modelId: "contract-null-output-with-tools",
    aliases: [],
    outputModalities: null,
    supportsTools: true,
  },
  {
    modelId: "contract-empty-output-with-thinking",
    aliases: [],
    outputModalities: [],
    supportsThinking: true,
  },
  {
    modelId: "contract-video-output-with-text",
    aliases: [],
    outputModalities: ["text"],
    videoOutput: true,
  },
  {
    modelId: "contract-vision-only",
    aliases: [],
    supportsVision: true,
    supportsTools: false,
  },
  {
    modelId: "contract-tools-with-vision",
    aliases: [],
    supportsVision: true,
    supportsTools: true,
  },
  {
    modelId: "contract-catalog-silent",
    aliases: [],
  },
];

let tempDir = "";
let cachePath = "";

beforeEach(() => {
  // The classifier memoizes its catalog projection across files; drop it so this fixture is read.
  _clearChatCapabilityIndex();
  tempDir = mkdtempSync(join(tmpdir(), "claudish-output-modalities-"));
  cachePath = join(tempDir, "cloud-models-catalog-v3.json");
  const cache: DiskCacheV3 = {
    version: 3,
    lastUpdated: "2026-09-20T15:44:25.586Z",
    catalogGenerationId: CATALOG_GENERATION_ID,
    entries: [...liveRows, ...contractRows],
    models: [],
    plans: [],
  };
  writeAllModelsCache(cache, cachePath);
});

afterEach(() => {
  _clearChatCapabilityIndex();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("chat capability from output modalities", () => {
  test("catalog text output outranks an image-generator name", () => {
    expect(classifyChatCapability("gpt-5-image", cachePath)).toBe("chat");
  });

  test("catalog non-text output outranks an innocent name and a chat-shaped flag", () => {
    expect(classifyChatCapability("nano-banana-pro", cachePath)).toBe("not-chat");
  });

  test("a mixed audio and text output is chat", () => {
    expect(classifyChatCapability("qwen-audio-3.0-realtime-plus", cachePath)).toBe("chat");
  });

  test.each([
    ["image", "gpt-image-2.5-flare"],
    ["video", "gemini-omni-1.1-flash"],
    ["audio", "qwen-audio-3.0-tts-flash"],
    ["embeddings", "gemini-embedding-2"],
    ["transcription", "mai-transcribe-2"],
    ["speech", "mai-voice-2"],
    ["rerank", "llama-nemotron-rerank-vl-1b-v2"],
    ["decisions", "jev-1.13"],
  ])("a live singleton %s output denies chat", (_output, modelId) => {
    expect(classifyChatCapability(modelId, cachePath)).toBe("not-chat");
  });

  test.each([
    ["null", "contract-null-output-with-tools"],
    ["empty", "contract-empty-output-with-thinking"],
  ])("a contract-only %s output list falls through to chat-shaped flags", (_case, modelId) => {
    expect(classifyChatCapability(modelId, cachePath)).toBe("chat");
  });

  test("text output outranks videoOutput:true in the contract-only disagreement", () => {
    expect(classifyChatCapability("contract-video-output-with-text", cachePath)).toBe("chat");
  });

  test("an alias is indexed the same way as its distinct canonical id", () => {
    expect(classifyChatCapability("gemini-3.1-flash-image", cachePath)).toBe("chat");
    expect(classifyChatCapability("google/flash-image-3.1", cachePath)).toBe("chat");
  });

  test("a wildcard route remains not-chat before catalog lookup", () => {
    expect(classifyChatCapability("gemini/*", cachePath)).toBe("not-chat");
  });

  test.each(["unpublished-image-generator", "unpublished-model-t2v"])(
    "an absent model remains unknown regardless of its name: %s",
    (modelId) => {
      expect(classifyChatCapability(modelId, cachePath)).toBe("unknown");
    }
  );

  test("an absent model with no matching name rule remains unknown", () => {
    expect(classifyChatCapability("unpublished-chat-model", cachePath)).toBe("unknown");
  });

  test("provider evidence decides and outranks the catalog", () => {
    expect(classifyChatCapability("gpt-5-image", cachePath)).toBe("chat");
    expect(classifyChatCapability("gpt-5-image", cachePath, "not-chat")).toBe("not-chat");
    expect(isReportedChatCapable("gpt-5-image", "not-chat")).toBeFalse();

    expect(classifyChatCapability("nano-banana-pro", cachePath)).toBe("not-chat");
    expect(classifyChatCapability("nano-banana-pro", cachePath, "chat")).toBe("chat");
    expect(isReportedChatCapable("nano-banana-pro", "chat")).toBeTrue();
  });

  test("supportsVision is not chat evidence but supportsTools is", () => {
    expect(classifyChatCapability("contract-vision-only", cachePath)).toBe("unknown");
    expect(classifyChatCapability("contract-tools-with-vision", cachePath)).toBe("chat");
  });

  test("unavailable capability data separates catalog and provider silence", () => {
    expect(
      unavailableForMissingCapability(
        ["contract-catalog-silent", "provider-only-undescribed"],
        undefined,
        cachePath
      )
    ).toEqual({
      catalogSilent: ["contract-catalog-silent"],
      providerSilent: ["provider-only-undescribed"],
    });
  });
});
