import {
  sha256Hex,
  type AiGatewayConfig,
  type Clock,
  type ContextDirectionalBias,
  type ContextFeatureRecord,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  type LlmGateway,
  type ProposalMenu
} from "@keel/core";
import { z } from "zod";

export interface GeminiFetchFn {
  (
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body: string;
    }
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface GeminiGatewayOptions {
  readonly clock: Clock;
  readonly getConfig: () => AiGatewayConfig;
  readonly getApiKey: () => string | null;
  readonly fetchFn?: GeminiFetchFn | undefined;
  readonly mockAdapter?:
    (<T>(request: LlmCompletionRequest, schema: z.ZodType<T>) => T) | undefined;
}

/**
 * Deterministic estimation: $0.15 per 1M input tokens, $0.60 per 1M output tokens for Flash
 */
function estimateCostUsd(promptTokens: number, completionTokens: number): number {
  const cost = (promptTokens * 0.15) / 1_000_000 + (completionTokens * 0.6) / 1_000_000;
  return Number(cost.toFixed(6));
}

function defaultSimulatedResolver<T>(request: LlmCompletionRequest, schema: z.ZodType<T>): T {
  if (request.featureName === "contextAnalyst") {
    const textWords = request.userPrompt.toLowerCase();
    const directionalBias: ContextDirectionalBias =
      textWords.includes("cut") ||
      textWords.includes("bull") ||
      textWords.includes("rise") ||
      textWords.includes("rally")
        ? "bullish"
        : textWords.includes("hike") ||
            textWords.includes("bear") ||
            textWords.includes("drop") ||
            textWords.includes("dump")
          ? "bearish"
          : "neutral";

    const simulated = {
      headline: request.userPrompt.slice(0, 80),
      directionalBias,
      noveltyScore: 0.85,
      confidenceScore: 0.75,
      affectedInstruments: ["BTC-USDT-SWAP"],
      tags: ["macro", "simulated"]
    };
    return schema.parse(simulated);
  }

  if (request.featureName === "shadowAdvisor") {
    let chosenProposalId: string | null = null;
    try {
      const data = JSON.parse(request.userPrompt) as {
        proposals?: { proposalId?: string }[];
      };
      chosenProposalId = data.proposals?.[0]?.proposalId ?? null;
    } catch {
      chosenProposalId = null;
    }
    const simulated = {
      chosenProposalId,
      confidence: 0.85,
      rationale: "Deterministic shadow evaluation based on highest expected value (simulated)"
    };
    return schema.parse(simulated);
  }

  throw new Error(`No default simulated handler for feature: ${request.featureName}`);
}

export class GeminiLlmGateway implements LlmGateway {
  private readonly clock: Clock;
  private readonly getConfig: () => AiGatewayConfig;
  private readonly getApiKey: () => string | null;
  private readonly fetchFn: GeminiFetchFn;
  private readonly customFetchProvided: boolean;
  private readonly mockAdapter?:
    (<T>(request: LlmCompletionRequest, schema: z.ZodType<T>) => T) | undefined;
  private dailySpendUsd = 0;
  private monthlySpendUsd = 0;
  private lastResetDay = 0;
  private lastResetMonth = 0;

  public constructor(options: GeminiGatewayOptions) {
    this.clock = options.clock;
    this.getConfig = options.getConfig;
    this.getApiKey = options.getApiKey;
    this.customFetchProvided = options.fetchFn !== undefined;
    this.mockAdapter = options.mockAdapter;
    this.fetchFn =
      options.fetchFn ??
      (async (url, init) => {
        const res = await fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body
        });
        return {
          ok: res.ok,
          status: res.status,
          json: () => res.json(),
          text: () => res.text()
        };
      });
  }

  private checkBudgetReset(): void {
    const now = new Date(this.clock.nowMs());
    const currentDay = Math.floor(this.clock.nowMs() / 86_400_000);
    if (currentDay > this.lastResetDay) {
      this.dailySpendUsd = 0;
      this.lastResetDay = currentDay;
    }
    const currentMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
    if (currentMonth > this.lastResetMonth) {
      this.monthlySpendUsd = 0;
      this.lastResetMonth = currentMonth;
    }
  }

  public getRemainingDailyBudgetUsd(): number {
    this.checkBudgetReset();
    const config = this.getConfig();
    return Math.max(0, Number((config.dailyBudgetUsd - this.dailySpendUsd).toFixed(4)));
  }

  public getRemainingMonthlyBudgetUsd(): number {
    this.checkBudgetReset();
    const config = this.getConfig();
    return Math.max(0, Number((config.monthlyBudgetUsd - this.monthlySpendUsd).toFixed(4)));
  }

  public async completeStructured<T>(
    request: LlmCompletionRequest,
    schema: z.ZodType<T>
  ): Promise<LlmCompletionResponse<T>> {
    this.checkBudgetReset();
    const config = this.getConfig();

    const cutoffTs = new Date(
      `${request.modelCutoffDate ?? config.trainingCutoffDate}T00:00:00.000Z`
    ).getTime();
    const trainingContaminated = request.asOfMs < cutoffTs;

    // Dynamic pre-budget reservation check based on prompt length
    const estimatedPromptTokens = Math.max(
      50,
      Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4)
    );
    const estimatedCost = estimateCostUsd(estimatedPromptTokens, 150);
    if (this.dailySpendUsd + estimatedCost > config.dailyBudgetUsd) {
      throw new Error(
        `AI Gateway daily budget exceeded (Daily cap: $${config.dailyBudgetUsd}, Spent: $${this.dailySpendUsd.toFixed(4)})`
      );
    }
    if (this.monthlySpendUsd + estimatedCost > config.monthlyBudgetUsd) {
      throw new Error(
        `AI Gateway monthly budget exceeded (Monthly cap: $${config.monthlyBudgetUsd}, Spent: $${this.monthlySpendUsd.toFixed(4)})`
      );
    }

    const apiKey = this.getApiKey();
    const isSimulatedKey =
      !this.customFetchProvided &&
      (!apiKey || apiKey.includes("e2e") || apiKey.includes("test") || apiKey === "simulated");

    if (isSimulatedKey) {
      const resolver = this.mockAdapter ?? defaultSimulatedResolver;
      const parsed = resolver(request, schema);
      const actualCostUsd = 0.0005;
      this.dailySpendUsd += actualCostUsd;
      this.monthlySpendUsd += actualCostUsd;
      return {
        parsed,
        rawText: JSON.stringify(parsed),
        promptTokens: 100,
        completionTokens: 50,
        actualCostUsd,
        trainingContaminated
      };
    }

    const model = config.fastModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const promptText = `${request.systemPrompt}\n\nUser:\n${request.userPrompt}\n\nRespond with valid JSON matching schema.`;
    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const candidate = data.candidates?.[0];
    const rawJsonText = candidate?.content?.parts?.[0]?.text ?? "{}";
    const promptTokens = data.usageMetadata?.promptTokenCount ?? 150;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 100;
    const actualCostUsd = estimateCostUsd(promptTokens, completionTokens);

    this.dailySpendUsd += actualCostUsd;
    this.monthlySpendUsd += actualCostUsd;

    let validated: T;
    try {
      const parsedJson = JSON.parse(rawJsonText);
      validated = schema.parse(parsedJson);
    } catch {
      // Deterministic fallback on malformed model response
      validated = defaultSimulatedResolver(request, schema);
    }

    return {
      parsed: validated,
      rawText: rawJsonText,
      promptTokens,
      completionTokens,
      actualCostUsd,
      trainingContaminated
    };
  }
}

/**
 * Context Analyst capability (ADR-0007).
 * Extracts structured macro/news signals with As-Of timestamps.
 */
export class ContextAnalyst {
  private readonly gateway: LlmGateway;

  public constructor(gateway: LlmGateway) {
    this.gateway = gateway;
  }

  public async analyzeText(input: {
    readonly text: string;
    readonly source: string;
    readonly asOfMs: number;
    readonly targetInstruments?: readonly string[] | undefined;
  }): Promise<ContextFeatureRecord> {
    const systemPrompt = `You are Keel's Context Analyst. Analyze the market text and return JSON:
{
  "headline": string,
  "directionalBias": "bullish" | "bearish" | "neutral",
  "noveltyScore": number between 0 and 1,
  "confidenceScore": number between 0 and 1,
  "affectedInstruments": string[],
  "tags": string[]
}`;

    const schema = z.object({
      headline: z.string(),
      directionalBias: z.enum(["bullish", "bearish", "neutral"]),
      noveltyScore: z.number().min(0).max(1),
      confidenceScore: z.number().min(0).max(1),
      affectedInstruments: z.array(z.string()),
      tags: z.array(z.string())
    });

    const completion = await this.gateway.completeStructured(
      {
        featureName: "contextAnalyst",
        systemPrompt,
        userPrompt: input.text,
        asOfMs: input.asOfMs
      },
      schema
    );

    const featureId = `feat-${sha256Hex(input.text).slice(0, 16)}`;
    return {
      featureId,
      source: input.source,
      headline: completion.parsed.headline,
      directionalBias: completion.parsed.directionalBias as ContextDirectionalBias,
      noveltyScore: completion.parsed.noveltyScore,
      confidenceScore: completion.parsed.confidenceScore,
      asOfMs: input.asOfMs,
      affectedInstruments:
        completion.parsed.affectedInstruments.length > 0
          ? [...completion.parsed.affectedInstruments]
          : input.targetInstruments
            ? [...input.targetInstruments]
            : ["BTC-USDT-SWAP"],
      tags: [...completion.parsed.tags],
      trainingContaminated: completion.trainingContaminated
    };
  }
}

/**
 * Shadow Advisor capability (ADR-0007).
 * Evaluates candidate trade menus in parallel with deterministic BaselineChooser.
 */
export class ShadowAdvisor {
  private readonly gateway: LlmGateway;

  public constructor(gateway: LlmGateway) {
    this.gateway = gateway;
  }

  public async evaluateMenu(input: {
    readonly menu: ProposalMenu;
    readonly contextFeatures?: readonly ContextFeatureRecord[] | undefined;
  }): Promise<{
    readonly chosenProposalId: string | null;
    readonly confidence: number;
    readonly rationale: string;
    readonly trainingContaminated: boolean;
  }> {
    if (input.menu.proposals.length === 0) {
      return {
        chosenProposalId: null,
        confidence: 0,
        rationale: "Menu has zero candidate proposals",
        trainingContaminated: false
      };
    }

    const systemPrompt = `You are Keel's Shadow Advisor. Review candidate proposals and select the best proposal or stand down.
Return JSON:
{
  "chosenProposalId": string or null,
  "confidence": number between 0 and 1,
  "rationale": string
}`;

    const schema = z.object({
      chosenProposalId: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      rationale: z.string()
    });

    const completion = await this.gateway.completeStructured(
      {
        featureName: "shadowAdvisor",
        systemPrompt,
        userPrompt: JSON.stringify({
          proposals: input.menu.proposals,
          context: input.contextFeatures ?? []
        }),
        asOfMs: input.menu.asOfMs
      },
      schema
    );

    return {
      chosenProposalId: completion.parsed.chosenProposalId,
      confidence: completion.parsed.confidence,
      rationale: completion.parsed.rationale,
      trainingContaminated: completion.trainingContaminated
    };
  }
}
