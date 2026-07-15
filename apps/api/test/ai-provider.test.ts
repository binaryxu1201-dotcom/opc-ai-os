import { describe, expect, it } from "vitest";
import { AiProviderAdapter, MockAiProvider, type AiProviderResponse } from "../src/ai/provider.js";

const request = {
  model: "mock-v1",
  messages: [{ role: "system" as const, content: "Return structured output." }]
};

const response: AiProviderResponse = {
  content: "{\"tasks\":[]}",
  modelVersion: "mock-v1",
  inputTokens: 10,
  outputTokens: 5
};

describe("AI provider adapter", () => {
  it("uses the mock provider and returns its structured response", async () => {
    const provider = new MockAiProvider(async (received) => {
      expect(received).toEqual(request);
      return response;
    });

    await expect(new AiProviderAdapter(provider).generate(request)).resolves.toEqual(response);
  });

  it("retries a provider failure once without exposing its internal error", async () => {
    let attempts = 0;
    const provider = new MockAiProvider(async () => {
      attempts += 1;
      throw new Error("upstream secret diagnostic");
    });

    await expect(new AiProviderAdapter(provider).generate(request)).rejects.toMatchObject({ statusCode: 503, code: "AI_PROVIDER_UNAVAILABLE", message: "AI 服务暂时不可用，请稍后重试。" });
    expect(attempts).toBe(2);
  });

  it("times out each bounded attempt and returns only a stable timeout error", async () => {
    let attempts = 0;
    const provider = new MockAiProvider(async (_request, signal) => {
      attempts += 1;
      await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("provider timing detail");
    });

    await expect(new AiProviderAdapter(provider, { timeoutMs: 5 }).generate(request)).rejects.toMatchObject({ statusCode: 503, code: "AI_TIMEOUT", message: "AI 服务响应超时，请稍后重试。" });
    expect(attempts).toBe(2);
  });

  it("enforces the timeout even if a provider ignores the abort signal", async () => {
    let attempts = 0;
    const provider = new MockAiProvider(async () => {
      attempts += 1;
      await new Promise<void>(() => undefined);
      return response;
    });

    await expect(new AiProviderAdapter(provider, { timeoutMs: 5 }).generate(request)).rejects.toMatchObject({ statusCode: 503, code: "AI_TIMEOUT" });
    expect(attempts).toBe(2);
  });

  it("opens for sixty seconds after the configured failure rate and permits a recovery probe", async () => {
    let now = 1_000;
    let attempts = 0;
    const provider = new MockAiProvider(async () => {
      attempts += 1;
      throw new Error("provider unavailable");
    });
    const adapter = new AiProviderAdapter(provider, { maxAttempts: 1, circuitMinimumSamples: 2, circuitFailureRate: 0.3, now: () => now });

    await expect(adapter.generate(request)).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: "AI_CIRCUIT_OPEN" });
    expect(attempts).toBe(2);

    now += 60_000;
    await expect(adapter.generate(request)).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    expect(attempts).toBe(3);
  });
});
