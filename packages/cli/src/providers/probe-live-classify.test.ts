import { describe, expect, test } from "bun:test";
import {
  buildSurfacedErrorMessage,
  wrapAnthropicError,
} from "../handlers/shared/anthropic-error.js";
import { classifyHttpError } from "./probe-live.js";

/** The Anthropic-style error body emitted by the proxy for an upstream failure. */
function proxyErrorBody(status: number, message: string): string {
  return JSON.stringify(wrapAnthropicError(status, message));
}

/** The exact body shape emitted when the proxy remaps a terminal upstream error to HTTP 400. */
function remappedTerminalBody(
  upstreamStatus: number,
  providerMessage: string,
  hint: string
): string {
  const surfaced = buildSurfacedErrorMessage({
    providerDisplayName: "OpenCode Zen Go",
    status: upstreamStatus,
    hint,
    providerMessage,
  });
  return JSON.stringify(wrapAnthropicError(400, surfaced, "invalid_request_error", upstreamStatus));
}

const REGION_OPT_IN_URL = "https://opencode.ai/workspace/0123456789abcdef0123456789abcdef/go";
const REGION_ERROR_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "RegionError",
    message: `The latest version of this model is only available hosted in China and requires explicit opt in: ${REGION_OPT_IN_URL}`,
  },
});

const ALIBABA_ACCESS_DENIED_SSE =
  'event:error\ndata:{"code":"AccessDenied","message":"Model access denied.","request_id":"ecbdbfc8-..."}';
const ALIBABA_COMPOSED_MESSAGE =
  "Alibaba PAYG error (HTTP 403): The provider accepted the credential but denied access to this model — check model access or activation for this account in the provider's console, not the key. — Model access denied.";

describe("classifyHttpError — auth-shaped model errors", () => {
  test("prefers provider evidence while preserving composed and raw-SSE fallbacks", () => {
    const proxyBody = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: ALIBABA_COMPOSED_MESSAGE,
        upstream_status: 403,
        provider_message: "Model access denied.",
      },
    });

    expect(classifyHttpError(400, proxyBody, 1200).errorMessage).toBe("Model access denied.");

    const bodyWithoutProviderMessage = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: ALIBABA_COMPOSED_MESSAGE,
        upstream_status: 403,
      },
    });

    expect(classifyHttpError(400, bodyWithoutProviderMessage, 1200).errorMessage).toBe(
      ALIBABA_COMPOSED_MESSAGE
    );
    expect(classifyHttpError(403, ALIBABA_ACCESS_DENIED_SSE, 1200).errorMessage).toBe(
      "Model access denied."
    );
  });

  test("classifies a 401 unsupported-model response without rewriting its status", () => {
    const body = proxyErrorBody(401, "Model deepseek-v4-pro-0813 is not supported");

    const result = classifyHttpError(401, body, 37);

    expect(result.state).toBe("model-not-found");
    // Keep the provider's real (misused) status visible rather than laundering it into a 404.
    expect(result.httpStatus).toBe(401);
  });

  test("keeps the captured invalid-key 401 classified as an authentication failure", () => {
    const body = proxyErrorBody(401, "Invalid API key.");

    const result = classifyHttpError(401, body, 38);

    expect(result.state).toBe("auth-failed");
    expect(result.httpStatus).toBe(401);
  });

  test("classifies a 403 with the provider's opt-in link as error and preserves the full URL", () => {
    const result = classifyHttpError(403, REGION_ERROR_BODY, 39);

    expect(result.state).toBe("error");
    expect(result.httpStatus).toBe(403);
    expect(result.errorMessage).toContain(REGION_OPT_IN_URL);
  });

  test("keeps a URL-free invalid-key 401 classified as an authentication failure", () => {
    const result = classifyHttpError(401, "Invalid API key.", 40);

    expect(result.state).toBe("auth-failed");
    expect(result.httpStatus).toBe(401);
  });

  test("distinguishes unsupported-model and authentication wording under HTTP 403", () => {
    const unsupported = classifyHttpError(
      403,
      proxyErrorBody(403, "Unsupported model: deepseek-v4-pro-0813"),
      41
    );
    const forbidden = classifyHttpError(403, proxyErrorBody(403, "Forbidden"), 42);

    expect(unsupported.state).toBe("model-not-found");
    expect(unsupported.httpStatus).toBe(403);
    expect(forbidden.state).toBe("auth-failed");
    expect(forbidden.httpStatus).toBe(403);
  });

  test("uses an embedded upstream 401 for both remapped terminal-error arms", () => {
    const unsupported = classifyHttpError(
      400,
      remappedTerminalBody(
        401,
        "Model deepseek-v4-pro-0813 is not supported",
        "Model not supported by this provider. Verify model name."
      ),
      43
    );
    const unauthorized = classifyHttpError(
      400,
      remappedTerminalBody(401, "Unauthorized", "Check API key / OAuth credentials."),
      44
    );

    expect(unsupported.state).toBe("model-not-found");
    expect(unsupported.httpStatus).toBe(401);
    expect(unauthorized.state).toBe("auth-failed");
    expect(unauthorized.httpStatus).toBe(401);
  });

  test("leaves unrelated HTTP classifications unchanged", () => {
    const cases = [
      { status: 404, message: "Requested model does not exist", state: "model-not-found" },
      { status: 429, message: "Rate limit exceeded", state: "rate-limited" },
      { status: 500, message: "Internal server error", state: "server-error" },
    ] as const;

    for (const { status, message, state } of cases) {
      const result = classifyHttpError(status, proxyErrorBody(status, message), 45);
      expect(result.state).toBe(state);
      expect(result.httpStatus).toBe(status);
    }
  });
});
