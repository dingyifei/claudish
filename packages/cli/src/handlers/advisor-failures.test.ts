import { describe, expect, test } from "bun:test";
import { ADVISOR_STUB_PATHS, runAdvisorCall } from "./native-handler-advisor";

const messages = [{ role: "user", content: "Review this change." }];
const apiKeys = { openrouter: "test-openrouter-key" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fixedFetch(response: Response): typeof fetch {
  return Object.assign(async () => response.clone(), {
    preconnect(_url: string | URL): void {},
  });
}

describe("runAdvisorCall failure handling", () => {
  test("turns an HTTP 400 panel response into a named stub failure", async () => {
    const model = "openrouter@acme/failing-model";
    const reason = "the requested model is unavailable";

    const outcome = await runAdvisorCall({
      toolUseId: "advisor-http-400",
      messages,
      models: [model],
      collector: null,
      apiKeys,
      fetchImpl: fixedFetch(jsonResponse({ error: { message: reason } }, 400)),
      warn: () => {},
    });

    expect(outcome.panel[0].origin).not.toBe("upstream");
    const stubPath = outcome.panel[0].stubPath;
    expect(stubPath).not.toBeNull();
    if (stubPath === null) throw new Error("Expected a named advisor stub path");
    expect(Object.values(ADVISOR_STUB_PATHS)).toContain(stubPath);
    expect(outcome.panel[0].stubPath).toBe(ADVISOR_STUB_PATHS.PANEL_ERROR);
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.text).toContain(model);
    expect(outcome.result.text).toContain(reason);
  });

  test("treats an HTTP 200 response with an empty answer as a failure", async () => {
    const model = "openrouter@acme/empty-model";

    const outcome = await runAdvisorCall({
      toolUseId: "advisor-empty-200",
      messages,
      models: [model],
      collector: null,
      apiKeys,
      fetchImpl: fixedFetch(jsonResponse({ choices: [{ message: { content: "   " } }] })),
      warn: () => {},
    });

    expect(outcome.panel[0].origin).not.toBe("upstream");
    expect(outcome.panel[0].stubPath).toBe(ADVISOR_STUB_PATHS.PANEL_EMPTY);
    expect(outcome.panel[0].text).toBeUndefined();
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.text).toContain(model);
  });

  test("preserves successful advice and reports a failed peer without a collector", async () => {
    const failedModel = "openrouter@acme/failing-peer";
    const successfulModel = "openrouter@acme/successful-peer";
    const successfulText = "Keep the validation at the boundary.";
    const failureReason = "temporary provider rejection";
    const warnings: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { model: string };
      return request.model === "acme/failing-peer"
        ? jsonResponse({ error: { message: failureReason } }, 400)
        : jsonResponse({ choices: [{ message: { content: successfulText } }] });
    }) as typeof fetch;

    const outcome = await runAdvisorCall({
      toolUseId: "advisor-partial-panel",
      messages,
      models: [failedModel, successfulModel],
      collector: null,
      apiKeys,
      fetchImpl,
      warn: (message) => warnings.push(message),
    });

    expect(outcome.result.isError).toBe(false);
    expect(outcome.result.text).toContain(successfulText);
    expect(outcome.result.text).toContain(failedModel);
    expect(outcome.result.text).toContain(failureReason);
    expect(outcome.panel.find((item) => item.requestedModel === failedModel)).toMatchObject({
      origin: "stub",
      stubPath: ADVISOR_STUB_PATHS.PANEL_ERROR,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(failedModel);
  });

  test("raises exactly one warning for a failed call and names every failed model", async () => {
    const models = ["openrouter@acme/failure-one", "openrouter@acme/failure-two"];
    const warnings: string[] = [];

    await runAdvisorCall({
      toolUseId: "advisor-warning-count",
      messages,
      models,
      collector: null,
      apiKeys,
      fetchImpl: fixedFetch(jsonResponse({ error: { message: "provider refused" } }, 400)),
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(models[0]);
    expect(warnings[0]).toContain(models[1]);
  });

  test("redacts credential-shaped provider text while preserving the reason", async () => {
    const model = "openrouter@acme/credential-error";
    const rawSecret = `sk-${"x".repeat(20)}`;
    const reasonPrefix = "Incorrect API key";

    const outcome = await runAdvisorCall({
      toolUseId: "advisor-secret-redaction",
      messages,
      models: [model],
      collector: null,
      apiKeys,
      fetchImpl: fixedFetch(
        jsonResponse({ error: { message: `${reasonPrefix}: ${rawSecret}; request denied` } }, 400)
      ),
      warn: () => {},
    });

    expect(outcome.result.text).not.toContain(rawSecret);
    expect(outcome.result.text).toContain(reasonPrefix);
    expect(outcome.result.text).toContain("request denied");
  });
});
