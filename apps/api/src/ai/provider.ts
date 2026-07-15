import { ApiError } from "../platform/errors.js";

export type AiMessage = {
  role: "system" | "user";
  content: string;
};

export type AiProviderRequest = {
  model: string;
  messages: readonly AiMessage[];
};

export type AiProviderResponse = {
  content: string;
  modelVersion: string;
  inputTokens: number;
  outputTokens: number;
};

export interface AiProvider {
  generate(request: AiProviderRequest, signal: AbortSignal): Promise<AiProviderResponse>;
}

export interface AiProviderAdapterOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  circuitWindowMs?: number;
  circuitOpenMs?: number;
  circuitMinimumSamples?: number;
  circuitFailureRate?: number;
  now?: () => number;
}

type Outcome = {
  occurredAt: number;
  failed: boolean;
};

function stableProviderError(code: "AI_TIMEOUT" | "AI_PROVIDER_UNAVAILABLE" | "AI_CIRCUIT_OPEN"): ApiError {
  const message = {
    AI_TIMEOUT: "AI 服务响应超时，请稍后重试。",
    AI_PROVIDER_UNAVAILABLE: "AI 服务暂时不可用，请稍后重试。",
    AI_CIRCUIT_OPEN: "AI 服务暂时不可用，请稍后重试。"
  }[code];
  return new ApiError(503, code, message);
}

export class AiProviderAdapter {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly circuitWindowMs: number;
  private readonly circuitOpenMs: number;
  private readonly circuitMinimumSamples: number;
  private readonly circuitFailureRate: number;
  private readonly now: () => number;
  private readonly outcomes: Outcome[] = [];
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly provider: AiProvider, options: AiProviderAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.circuitWindowMs = options.circuitWindowMs ?? 300_000;
    this.circuitOpenMs = options.circuitOpenMs ?? 60_000;
    this.circuitMinimumSamples = options.circuitMinimumSamples ?? 3;
    this.circuitFailureRate = options.circuitFailureRate ?? 0.3;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || !Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("Invalid AI provider adapter retry or timeout configuration");
    }
  }

  public async generate(request: AiProviderRequest): Promise<AiProviderResponse> {
    const now = this.now();
    this.pruneOutcomes(now);
    if (this.circuitOpenedAt !== undefined) {
      if (now - this.circuitOpenedAt < this.circuitOpenMs) throw stableProviderError("AI_CIRCUIT_OPEN");
      this.circuitOpenedAt = undefined;
    }

    let timedOut = false;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        const response = await this.generateOnce(request);
        this.recordOutcome(false);
        return response;
      } catch (error) {
        timedOut ||= error instanceof ApiError && error.code === "AI_TIMEOUT";
      }
    }

    this.recordOutcome(true);
    throw stableProviderError(timedOut ? "AI_TIMEOUT" : "AI_PROVIDER_UNAVAILABLE");
  }

  private async generateOnce(request: AiProviderRequest): Promise<AiProviderResponse> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutReached = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(stableProviderError("AI_TIMEOUT"));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.provider.generate(request, controller.signal), timeoutReached]);
    } catch (error) {
      if (error instanceof ApiError && error.code === "AI_TIMEOUT") throw error;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private recordOutcome(failed: boolean): void {
    const now = this.now();
    this.pruneOutcomes(now);
    this.outcomes.push({ occurredAt: now, failed });
    const failures = this.outcomes.filter((outcome) => outcome.failed).length;
    if (this.outcomes.length >= this.circuitMinimumSamples && failures / this.outcomes.length >= this.circuitFailureRate) {
      this.circuitOpenedAt = now;
    }
  }

  private pruneOutcomes(now: number): void {
    const oldestAllowed = now - this.circuitWindowMs;
    while (true) {
      const oldest = this.outcomes[0];
      if (!oldest || oldest.occurredAt >= oldestAllowed) return;
      this.outcomes.shift();
    }
  }
}

export class MockAiProvider implements AiProvider {
  public constructor(private readonly handler: (request: AiProviderRequest, signal: AbortSignal) => Promise<AiProviderResponse>) {}

  public generate(request: AiProviderRequest, signal: AbortSignal): Promise<AiProviderResponse> {
    return this.handler(request, signal);
  }
}
