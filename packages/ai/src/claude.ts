import Anthropic from "@anthropic-ai/sdk";
import {
  type AiGatewayConfig,
  type Clock,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  type LlmGateway
} from "@keel/core";
import { type z } from "zod";

/** The one SDK call the gateway makes; injectable so tests never reach the network. */
export interface ClaudeMessagesClient {
  create(
    params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
  ): Promise<Anthropic.Beta.Messages.BetaMessage>;
}

export interface ClaudeGatewayOptions {
  readonly clock: Clock;
  readonly getConfig: () => AiGatewayConfig;
  readonly getApiKey: () => string | null;
  readonly createClient?: ((apiKey: string) => ClaudeMessagesClient) | undefined;
}

/** Claude Opus 5.5 list prices: $4 per 1M input tokens, $20 per 1M output tokens. */
function estimateClaudeCostUsd(inputTokens: number, outputTokens: number): number {
  return Number(((inputTokens * 4) / 1_000_000 + (outputTokens * 20) / 1_000_000).toFixed(6));
}

const MAX_OUTPUT_TOKENS = 16_000;

/** Without a schema-constrained answer, Claude may wrap its JSON in prose or a code fence. */
function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function defaultClient(apiKey: string): ClaudeMessagesClient {
  const client = new Anthropic({ apiKey });
  return { create: (params) => client.beta.messages.create(params) };
}

/**
 * LLM Gateway adapter for Claude. Shares the Gemini adapter's daily and monthly caps, reserving
 * the worst-case cost of a full response before every call.
 */
export class ClaudeLlmGateway implements LlmGateway {
  private readonly clock: Clock;
  private readonly getConfig: () => AiGatewayConfig;
  private readonly getApiKey: () => string | null;
  private readonly createClient: (apiKey: string) => ClaudeMessagesClient;
  private dailySpendUsd = 0;
  private monthlySpendUsd = 0;
  private lastResetDay = 0;
  private lastResetMonth = 0;

  public constructor(options: ClaudeGatewayOptions) {
    this.clock = options.clock;
    this.getConfig = options.getConfig;
    this.getApiKey = options.getApiKey;
    this.createClient = options.createClient ?? defaultClient;
  }

  public hasApiKey(): boolean {
    return this.getApiKey() !== null;
  }

  private checkBudgetReset(): void {
    const nowMs = this.clock.nowMs();
    const currentDay = Math.floor(nowMs / 86_400_000);
    if (currentDay > this.lastResetDay) {
      this.dailySpendUsd = 0;
      this.lastResetDay = currentDay;
    }
    const now = new Date(nowMs);
    const currentMonth = now.getUTCFullYear() * 12 + now.getUTCMonth();
    if (currentMonth > this.lastResetMonth) {
      this.monthlySpendUsd = 0;
      this.lastResetMonth = currentMonth;
    }
  }

  public getRemainingDailyBudgetUsd(): number {
    this.checkBudgetReset();
    return Math.max(0, Number((this.getConfig().dailyBudgetUsd - this.dailySpendUsd).toFixed(4)));
  }

  public getRemainingMonthlyBudgetUsd(): number {
    this.checkBudgetReset();
    return Math.max(
      0,
      Number((this.getConfig().monthlyBudgetUsd - this.monthlySpendUsd).toFixed(4))
    );
  }

  public async completeStructured<T>(
    request: LlmCompletionRequest,
    schema: z.ZodType<T>
  ): Promise<LlmCompletionResponse<T>> {
    this.checkBudgetReset();
    const config = this.getConfig();
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("Anthropic API key is not configured");
    }

    const estimatedInput = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
    const reserve = estimateClaudeCostUsd(estimatedInput, MAX_OUTPUT_TOKENS);
    if (this.dailySpendUsd + reserve > config.dailyBudgetUsd) {
      throw new Error(
        `AI daily budget too low for a Claude call (cap $${config.dailyBudgetUsd}, spent $${this.dailySpendUsd.toFixed(4)}, a call may cost up to $${reserve.toFixed(2)})`
      );
    }
    if (this.monthlySpendUsd + reserve > config.monthlyBudgetUsd) {
      throw new Error(
        `AI monthly budget too low for a Claude call (cap $${config.monthlyBudgetUsd}, spent $${this.monthlySpendUsd.toFixed(4)})`
      );
    }

    const message = await this.createClient(apiKey).create({
      model: config.botDesignerModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Policy declines re-run on a fallback model chosen by the API inside the same call
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userPrompt }],
      // Deep requests let Claude think first, as much as the problem needs
      ...(request.reasoning === "deep" ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        effort: request.reasoning === "deep" ? "high" : "medium",
        ...(request.outputJsonSchema
          ? { format: { type: "json_schema", schema: { ...request.outputJsonSchema } } }
          : {})
      }
    });

    const actualCostUsd = estimateClaudeCostUsd(
      message.usage.input_tokens,
      message.usage.output_tokens
    );
    this.dailySpendUsd += actualCostUsd;
    this.monthlySpendUsd += actualCostUsd;

    if (message.stop_reason === "refusal") {
      throw new Error("Claude declined this request");
    }
    if (message.stop_reason === "max_tokens") {
      throw new Error("Claude ran out of output tokens before finishing");
    }

    const rawText = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    const parsed = schema.parse(
      JSON.parse(request.outputJsonSchema ? rawText : extractJsonObject(rawText))
    );

    const cutoffTs = Date.parse(
      `${request.modelCutoffDate ?? config.trainingCutoffDate}T00:00:00.000Z`
    );
    return {
      parsed,
      rawText,
      promptTokens: message.usage.input_tokens,
      completionTokens: message.usage.output_tokens,
      actualCostUsd,
      trainingContaminated: request.asOfMs < cutoffTs
    };
  }
}
