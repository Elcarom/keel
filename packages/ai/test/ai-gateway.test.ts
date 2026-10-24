import { describe, expect, it } from "vitest";
import { ManualClock, createDefaultConfig, type Proposal } from "@keel/core";
import { ContextAnalyst, GeminiLlmGateway, ShadowAdvisor } from "../src/index.js";

function makeFakeProposal(id: string): Proposal {
  return {
    proposalId: id,
    strategyId: "donchian-trend",
    strategyVersion: "1.0.0",
    instrumentId: "BTC-USDT-SWAP",
    side: "long",
    entryPrice: "50000.00",
    protectiveStopPrice: "49000.00",
    takeProfitPrice: "52500.00",
    convictionScore: 0.82,
    rationale: "Donchian 20-bar upside breakout",
    tags: ["trend"]
  };
}

describe("GeminiLlmGateway, ContextAnalyst, & ShadowAdvisor (M4)", () => {
  it("enforces pre-call budget checks, handles structured output, and detects training contamination", async () => {
    const clock = new ManualClock(1_700_000_000_000); // 2023-11-14 -> pre-cutoff 2025-03-01
    const config = createDefaultConfig();

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    headline: "Federal Reserve Signals Dovish Pivot as Inflation Cools",
                    directionalBias: "bullish",
                    noveltyScore: 0.85,
                    confidenceScore: 0.92,
                    affectedInstruments: ["BTC-USDT-SWAP"],
                    tags: ["macro", "fed", "rate_cut"]
                  })
                }
              ]
            }
          }
        ],
        usageMetadata: {
          promptTokenCount: 200,
          candidatesTokenCount: 120
        }
      }),
      text: async () => ""
    });

    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => config.ai,
      getApiKey: () => "test-gemini-key",
      fetchFn: mockFetch
    });

    const analyst = new ContextAnalyst(gateway);
    const feature = await analyst.analyzeText({
      text: "Federal Reserve chair hints at upcoming rate cuts during speech.",
      source: "Reuters",
      asOfMs: 1_700_000_000_000
    });

    expect(feature.headline).toContain("Federal Reserve");
    expect(feature.directionalBias).toBe("bullish");
    expect(feature.trainingContaminated).toBe(true); // pre-cutoff 2025-03-01
    expect(gateway.getRemainingDailyBudgetUsd()).toBeLessThan(config.ai.dailyBudgetUsd);
  });

  it("shadow advisor evaluates proposal menu alongside deterministic baseline", async () => {
    const clock = new ManualClock(1_750_000_000_000); // post-cutoff
    const config = createDefaultConfig();

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    chosenProposalId: "prop-alpha",
                    confidence: 0.88,
                    rationale: "Strong confluence of trend breakout and low volatility expansion"
                  })
                }
              ]
            }
          }
        ],
        usageMetadata: {
          promptTokenCount: 300,
          candidatesTokenCount: 90
        }
      }),
      text: async () => ""
    });

    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => config.ai,
      getApiKey: () => "test-gemini-key",
      fetchFn: mockFetch
    });

    const shadowAdvisor = new ShadowAdvisor(gateway);
    const advice = await shadowAdvisor.evaluateMenu({
      menu: {
        strategyId: "donchian-trend",
        strategyVersion: "1.0.0",
        instrumentId: "BTC-USDT-SWAP",
        asOfMs: 1_750_000_000_000,
        proposals: [makeFakeProposal("prop-alpha"), makeFakeProposal("prop-beta")]
      }
    });

    expect(advice.chosenProposalId).toBe("prop-alpha");
    expect(advice.confidence).toBe(0.88);
    expect(advice.trainingContaminated).toBe(false);
  });

  it("provides deterministic simulated analysis when no API key is configured", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => config.ai,
      getApiKey: () => null
    });

    const analyst = new ContextAnalyst(gateway);
    const feature = await analyst.analyzeText({
      text: "Federal Reserve confirms plans to slow balance sheet runoff at upcoming meeting.",
      source: "Operator Manual Desk",
      asOfMs: 1_750_000_000_000
    });

    expect(feature.headline).toContain("Federal Reserve");
    expect(feature.directionalBias).toBe("neutral");
    expect(feature.trainingContaminated).toBe(false);
    expect(gateway.getRemainingDailyBudgetUsd()).toBeLessThan(config.ai.dailyBudgetUsd);

    const shadow = new ShadowAdvisor(gateway);
    const advice = await shadow.evaluateMenu({
      menu: {
        strategyId: "donchian-trend",
        strategyVersion: "1.0.0",
        instrumentId: "BTC-USDT-SWAP",
        asOfMs: 1_750_000_000_000,
        proposals: [makeFakeProposal("prop-gamma")]
      }
    });

    expect(advice.chosenProposalId).toBe("prop-gamma");
    expect(advice.confidence).toBe(0.85);
  });

  it("throws clear error when daily or monthly budget cap is exceeded", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const exhaustedConfig = {
      ...config.ai,
      dailyBudgetUsd: 0.0001 // smaller than any estimated call
    };

    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => exhaustedConfig,
      getApiKey: () => "test-key"
    });

    const analyst = new ContextAnalyst(gateway);
    await expect(
      analyst.analyzeText({
        text: "Some market news",
        source: "Bloomberg",
        asOfMs: 1_750_000_000_000
      })
    ).rejects.toThrow(/AI Gateway daily budget exceeded/);
  });

  it("recovers with deterministic fallback when model returns malformed JSON", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: "This is NOT valid JSON { broken: true" }]
            }
          }
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
      }),
      text: async () => ""
    });

    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => config.ai,
      getApiKey: () => "test-key",
      fetchFn: mockFetch
    });

    const analyst = new ContextAnalyst(gateway);
    const feature = await analyst.analyzeText({
      text: "ECB interest rate decision pending this afternoon.",
      source: "Reuters",
      asOfMs: 1_750_000_000_000
    });

    expect(feature.headline).toContain("ECB interest rate decision");
    expect(feature.directionalBias).toBe("neutral");
  });
});
