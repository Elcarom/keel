import {
  sha256Hex,
  ScaledDecimal,
  type AiGatewayConfig,
  type Clock,
  type ContextDirectionalBias,
  type ContextFeatureRecord,
  type EventGateEvaluation,
  type EventGateRecommendation,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  type LlmGateway,
  type MarkoutForensicReport,
  type NarrativeClusterRecord,
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
  readonly simulateResponses?: boolean | undefined;
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

  if (request.featureName === "eventGateAdvisor") {
    const textLower = request.userPrompt.toLowerCase();
    const isExtreme =
      textLower.includes("war") ||
      textLower.includes("default") ||
      textLower.includes("emergency") ||
      textLower.includes("black swan");
    const isHigh =
      textLower.includes("cpi") ||
      textLower.includes("fomc") ||
      textLower.includes("rate decision") ||
      textLower.includes("sec");

    const volatilityRisk = isExtreme ? "extreme" : isHigh ? "high" : "moderate";
    const riskScore = isExtreme ? 0.95 : isHigh ? 0.72 : 0.35;
    const recommendation: EventGateRecommendation = isExtreme
      ? "STAND_DOWN"
      : isHigh
        ? "REDUCE_SIZE"
        : "PASS";

    const simulated = {
      eventHeadline: request.userPrompt.slice(0, 80),
      volatilityRisk,
      riskScore,
      recommendation,
      rationale: `Simulated event gate analysis based on keyword severity (${volatilityRisk})`,
      affectedInstruments: ["BTC-USDT-SWAP"],
      cooldownMinutes: isExtreme ? 120 : isHigh ? 30 : 0
    };
    return schema.parse(simulated);
  }

  if (request.featureName === "narrativeClusterTagger") {
    const textLower = request.userPrompt.toLowerCase();
    const theme =
      textLower.includes("fed") || textLower.includes("rate")
        ? "Central Bank Monetary Policy"
        : textLower.includes("etf") || textLower.includes("flow")
          ? "Institutional Capital Flows"
          : "Crypto Market Structure";

    const simulated = {
      clusters: [
        {
          clusterId: `clust_${sha256Hex(request.userPrompt).slice(0, 10)}`,
          name: theme,
          theme,
          sentimentBias: "neutral",
          noveltyScore: 0.78,
          affectedInstruments: ["BTC-USDT-SWAP"],
          announcementsCount: 1
        }
      ]
    };
    return schema.parse(simulated);
  }

  if (request.featureName === "markoutForensics") {
    const simulated = {
      markout5mBps: 5.2,
      markout15mBps: 11.4,
      markout1hBps: 18.6,
      adverseSelectionScore: 0.12,
      executionQualityRating: "EXCELLENT",
      recommendedAggressiveness: "OPTIMAL",
      forensicSummary:
        "Execution achieved positive markouts across 5m/15m/1H horizons with minimal post-fill adverse selection."
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
  private readonly simulateResponses?: boolean | undefined;
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
    this.simulateResponses = options.simulateResponses;
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

    const shouldSimulate = this.simulateResponses ?? config.simulateResponses ?? false;

    if (shouldSimulate) {
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

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("Gemini API key is required when simulateResponses is false");
    }

    const model = config.fastModel;
    // Gemini API: pass key via x-goog-api-key header, not URL query parameter
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const promptText = `${request.systemPrompt}\n\nUser:\n${request.userPrompt}\n\nRespond with valid JSON matching schema.`;
    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
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

/**
 * Event Gate Advisor capability (M6).
 * Analyzes market-moving macro announcements and geopolitical shocks to suggest risk gating.
 */
export class EventGateAdvisor {
  private readonly gateway: LlmGateway;

  public constructor(gateway: LlmGateway) {
    this.gateway = gateway;
  }

  public async evaluateEvent(input: {
    readonly eventText: string;
    readonly asOfMs: number;
    readonly affectedInstruments?: readonly string[] | undefined;
    readonly openPositionsCount?: number | undefined;
  }): Promise<EventGateEvaluation> {
    const systemPrompt = `You are Keel's Event Gate Advisor. Evaluate the volatility risk and impact of incoming market shocks or announcements.
Return JSON:
{
  "eventHeadline": string,
  "volatilityRisk": "low" | "moderate" | "high" | "extreme",
  "riskScore": number between 0 and 1,
  "recommendation": "PASS" | "REDUCE_SIZE" | "WIDEN_STOP" | "STAND_DOWN",
  "rationale": string,
  "affectedInstruments": string[],
  "cooldownMinutes": number
}`;

    const schema = z.object({
      eventHeadline: z.string(),
      volatilityRisk: z.enum(["low", "moderate", "high", "extreme"]),
      riskScore: z.number().min(0).max(1),
      recommendation: z.enum(["PASS", "REDUCE_SIZE", "WIDEN_STOP", "STAND_DOWN"]),
      rationale: z.string(),
      affectedInstruments: z.array(z.string()),
      cooldownMinutes: z.number().int().nonnegative()
    });

    const userPrompt = JSON.stringify({
      eventText: input.eventText,
      openPositionsCount: input.openPositionsCount ?? 0,
      affectedInstruments: input.affectedInstruments ?? ["BTC-USDT-SWAP"]
    });

    const completion = await this.gateway.completeStructured(
      {
        featureName: "eventGateAdvisor",
        systemPrompt,
        userPrompt,
        asOfMs: input.asOfMs
      },
      schema
    );

    return {
      asOfMs: input.asOfMs,
      eventHeadline: completion.parsed.eventHeadline,
      volatilityRisk: completion.parsed.volatilityRisk,
      riskScore: completion.parsed.riskScore,
      recommendation: completion.parsed.recommendation,
      rationale: completion.parsed.rationale,
      affectedInstruments:
        completion.parsed.affectedInstruments.length > 0
          ? completion.parsed.affectedInstruments
          : input.affectedInstruments
            ? [...input.affectedInstruments]
            : ["BTC-USDT-SWAP"],
      cooldownMinutes: completion.parsed.cooldownMinutes,
      trainingContaminated: completion.trainingContaminated
    };
  }
}

/**
 * Narrative Cluster Tagger capability (M6).
 * Semantic grouping of market context features into overarching narratives.
 */
export class NarrativeClusterTagger {
  private readonly gateway: LlmGateway;

  public constructor(gateway: LlmGateway) {
    this.gateway = gateway;
  }

  public async clusterAnnouncements(input: {
    readonly announcements: readonly string[];
    readonly asOfMs: number;
  }): Promise<readonly NarrativeClusterRecord[]> {
    if (input.announcements.length === 0) {
      return [];
    }

    const systemPrompt = `You are Keel's Narrative Cluster Tagger. Group announcements into thematic narrative clusters.
Return JSON:
{
  "clusters": [
    {
      "clusterId": string,
      "name": string,
      "theme": string,
      "sentimentBias": "bullish" | "bearish" | "neutral",
      "noveltyScore": number between 0 and 1,
      "affectedInstruments": string[],
      "announcementsCount": number
    }
  ]
}`;

    const schema = z.object({
      clusters: z.array(
        z.object({
          clusterId: z.string(),
          name: z.string(),
          theme: z.string(),
          sentimentBias: z.enum(["bullish", "bearish", "neutral"]),
          noveltyScore: z.number().min(0).max(1),
          affectedInstruments: z.array(z.string()),
          announcementsCount: z.number().int().nonnegative()
        })
      )
    });

    const completion = await this.gateway.completeStructured(
      {
        featureName: "narrativeClusterTagger",
        systemPrompt,
        userPrompt: JSON.stringify(input.announcements),
        asOfMs: input.asOfMs
      },
      schema
    );

    return completion.parsed.clusters.map((c) => ({
      clusterId: c.clusterId,
      name: c.name,
      theme: c.theme,
      sentimentBias: c.sentimentBias,
      noveltyScore: c.noveltyScore,
      affectedInstruments: c.affectedInstruments,
      announcementsCount: c.announcementsCount,
      asOfMs: input.asOfMs,
      trainingContaminated: completion.trainingContaminated
    }));
  }
}

/**
 * Markout Forensics Analyst capability (M6).
 * Analyzes post-fill price drift (+5m, +15m, +1H) to quantify adverse selection and execution quality.
 */
export class MarkoutForensicsAnalyst {
  private readonly gateway: LlmGateway;

  public constructor(gateway: LlmGateway) {
    this.gateway = gateway;
  }

  public async analyzeExecution(input: {
    readonly orderId: string;
    readonly instrumentId: string;
    readonly side: "long" | "short";
    readonly fillPrice: string;
    readonly markoutPrices?:
      | {
          readonly price5m?: string | undefined;
          readonly price15m?: string | undefined;
          readonly price1h?: string | undefined;
        }
      | undefined;
    readonly asOfMs: number;
  }): Promise<MarkoutForensicReport> {
    const parsedFill = ScaledDecimal.fromString(input.fillPrice);
    if (!parsedFill.isPositive()) {
      throw new Error(`Invalid fill price: ${input.fillPrice}. Must be positive.`);
    }

    const fillPx = Number(input.fillPrice);
    const px5m = input.markoutPrices?.price5m
      ? Number(input.markoutPrices.price5m)
      : fillPx * 1.0005;
    const px15m = input.markoutPrices?.price15m
      ? Number(input.markoutPrices.price15m)
      : fillPx * 1.0011;
    const px1h = input.markoutPrices?.price1h
      ? Number(input.markoutPrices.price1h)
      : fillPx * 1.0018;

    const mult = input.side === "long" ? 1 : -1;
    const markout5mBps = Number((((px5m - fillPx) / fillPx) * 10000 * mult).toFixed(2));
    const markout15mBps = Number((((px15m - fillPx) / fillPx) * 10000 * mult).toFixed(2));
    const markout1hBps = Number((((px1h - fillPx) / fillPx) * 10000 * mult).toFixed(2));

    const systemPrompt = `You are Keel's Markout Forensics Analyst. Evaluate trade execution quality and adverse selection.
Return JSON:
{
  "adverseSelectionScore": number between 0 and 1,
  "executionQualityRating": "EXCELLENT" | "ACCEPTABLE" | "ADVERSE_SELECTION" | "TOXIC",
  "recommendedAggressiveness": "MORE_PASSIVE" | "OPTIMAL" | "MORE_AGGRESSIVE",
  "forensicSummary": string
}`;

    const schema = z.object({
      adverseSelectionScore: z.number().min(0).max(1),
      executionQualityRating: z.enum(["EXCELLENT", "ACCEPTABLE", "ADVERSE_SELECTION", "TOXIC"]),
      recommendedAggressiveness: z.enum(["MORE_PASSIVE", "OPTIMAL", "MORE_AGGRESSIVE"]),
      forensicSummary: z.string()
    });

    let adverseSelectionScore: number;
    let executionQualityRating: "EXCELLENT" | "ACCEPTABLE" | "ADVERSE_SELECTION" | "TOXIC";
    let recommendedAggressiveness: "MORE_PASSIVE" | "OPTIMAL" | "MORE_AGGRESSIVE";
    let forensicSummary: string;
    let trainingContaminated = false;

    try {
      const completion = await this.gateway.completeStructured(
        {
          featureName: "markoutForensics",
          systemPrompt,
          userPrompt: JSON.stringify({
            orderId: input.orderId,
            instrumentId: input.instrumentId,
            side: input.side,
            fillPrice: input.fillPrice,
            markout5mBps,
            markout15mBps,
            markout1hBps
          }),
          asOfMs: input.asOfMs
        },
        schema
      );

      adverseSelectionScore = completion.parsed.adverseSelectionScore;
      executionQualityRating = completion.parsed.executionQualityRating;
      recommendedAggressiveness = completion.parsed.recommendedAggressiveness;
      forensicSummary = completion.parsed.forensicSummary;
      trainingContaminated = completion.trainingContaminated;
    } catch {
      // Deterministic heuristic fallback on budget exhaustion or LLM error (ADR-0007 / Issue #47)
      if (markout5mBps >= 0 && markout15mBps >= 0) {
        adverseSelectionScore = 0.1;
        executionQualityRating = "EXCELLENT";
        recommendedAggressiveness = "OPTIMAL";
        forensicSummary =
          "Deterministic heuristic fallback: Favorable positive drift post-fill across 5m/15m horizons.";
      } else if (markout5mBps < -15 || markout15mBps < -25) {
        adverseSelectionScore = 0.85;
        executionQualityRating = "TOXIC";
        recommendedAggressiveness = "MORE_PASSIVE";
        forensicSummary =
          "Deterministic heuristic fallback: High negative markout indicating adverse selection / liquidity cliff.";
      } else {
        adverseSelectionScore = 0.45;
        executionQualityRating = "ACCEPTABLE";
        recommendedAggressiveness = "OPTIMAL";
        forensicSummary =
          "Deterministic heuristic fallback: Moderate markout drift within typical noise bands.";
      }
    }

    return {
      orderId: input.orderId,
      instrumentId: input.instrumentId,
      side: input.side,
      fillPrice: input.fillPrice,
      markout5mBps,
      markout15mBps,
      markout1hBps,
      adverseSelectionScore,
      executionQualityRating,
      recommendedAggressiveness,
      forensicSummary,
      asOfMs: input.asOfMs,
      trainingContaminated
    };
  }
}
