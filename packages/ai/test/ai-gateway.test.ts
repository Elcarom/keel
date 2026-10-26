import { describe, expect, it } from "vitest";
import { ManualClock, createDefaultConfig, type Proposal } from "@keel/core";
import {
  ContextAnalyst,
  EventGateAdvisor,
  GeminiLlmGateway,
  MarkoutForensicsAnalyst,
  NarrativeClusterTagger,
  ShadowAdvisor
} from "../src/index.js";

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
      getApiKey: () => null,
      simulateResponses: true
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

  it("EventGateAdvisor evaluates volatility risk and issues gating advice (M6)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => ({ ...config.ai, simulateResponses: true }),
      getApiKey: () => "simulated-key"
    });

    const advisor = new EventGateAdvisor(gateway);
    const eval1 = await advisor.evaluateEvent({
      eventText: "Emergency FOMC announcement: surprise rate hike of 75 basis points",
      asOfMs: 1_750_000_000_000
    });

    expect(eval1.volatilityRisk).toMatch(/high|extreme/);
    expect(eval1.recommendation).toMatch(/REDUCE_SIZE|STAND_DOWN/);
    expect(eval1.cooldownMinutes).toBeGreaterThan(0);
    expect(eval1.trainingContaminated).toBe(false);
  });

  it("NarrativeClusterTagger clusters context features into semantic narratives (M6)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => ({ ...config.ai, simulateResponses: true }),
      getApiKey: () => "simulated-key"
    });

    const tagger = new NarrativeClusterTagger(gateway);
    const clusters = await tagger.clusterAnnouncements({
      announcements: [
        "Fed chair hints at rate cuts amid cooling inflation",
        "Treasury announces lower than expected quarterly debt issuance"
      ],
      asOfMs: 1_750_000_000_000
    });

    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0]?.name).toContain("Central Bank Monetary Policy");
    expect(clusters[0]?.sentimentBias).toBeDefined();
  });

  it("MarkoutForensicsAnalyst diagnoses post-fill markout drift and adverse selection (M6)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => ({ ...config.ai, simulateResponses: true }),
      getApiKey: () => "simulated-key"
    });

    const analyst = new MarkoutForensicsAnalyst(gateway);
    const report = await analyst.analyzeExecution({
      orderId: "ord-test-123",
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      fillPrice: "50000.00",
      markoutPrices: {
        price5m: "50025.00",
        price15m: "50060.00",
        price1h: "50100.00"
      },
      asOfMs: 1_750_000_000_000
    });

    expect(report.orderId).toBe("ord-test-123");
    expect(report.markout5mBps).toBe(5.0);
    expect(report.markout15mBps).toBe(12.0);
    expect(report.markout1hBps).toBe(20.0);
    expect(report.adverseSelectionScore).toBeLessThan(0.5);
    expect(report.executionQualityRating).toBe("EXCELLENT");
  });

  it("detects training contamination on pre-cutoff timestamps for EventGateAdvisor and MarkoutForensics (M6 / ADR-0007)", async () => {
    const preCutoffMs = 1_700_000_000_000; // 2023-11-14 < cutoff 2025-03-01
    const clock = new ManualClock(preCutoffMs);
    const config = createDefaultConfig();
    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => ({ ...config.ai, simulateResponses: true }),
      getApiKey: () => "simulated-key"
    });

    const advisor = new EventGateAdvisor(gateway);
    const gateEval = await advisor.evaluateEvent({
      eventText: "Historical announcement from 2023",
      asOfMs: preCutoffMs
    });
    expect(gateEval.trainingContaminated).toBe(true);

    const forensics = new MarkoutForensicsAnalyst(gateway);
    const report = await forensics.analyzeExecution({
      orderId: "ord-hist-1",
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      fillPrice: "50000.00",
      asOfMs: preCutoffMs
    });
    expect(report.trainingContaminated).toBe(true);
  });

  it("falls back gracefully to deterministic heuristics when LLM budget is exhausted (M6 / ADR-0007)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const exhaustedConfig = {
      ...config,
      ai: {
        ...config.ai,
        dailyBudgetUsd: 0.0001 // budget too low to allow LLM call
      }
    };

    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => ({ ...exhaustedConfig.ai, simulateResponses: true }),
      getApiKey: () => "simulated-key"
    });

    const analyst = new MarkoutForensicsAnalyst(gateway);
    // Execute with positive markouts
    const favorableReport = await analyst.analyzeExecution({
      orderId: "ord-exhausted-1",
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      fillPrice: "50000.00",
      markoutPrices: {
        price5m: "50050.00",
        price15m: "50100.00"
      },
      asOfMs: 1_750_000_000_000
    });

    expect(favorableReport.executionQualityRating).toBe("EXCELLENT");
    expect(favorableReport.recommendedAggressiveness).toBe("OPTIMAL");
    expect(favorableReport.adverseSelectionScore).toBe(0.1);
    expect(favorableReport.forensicSummary).toContain("Deterministic heuristic fallback");

    // Execute with severe adverse selection markouts
    const adverseReport = await analyst.analyzeExecution({
      orderId: "ord-exhausted-2",
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      fillPrice: "50000.00",
      markoutPrices: {
        price5m: "49800.00",
        price15m: "49700.00"
      },
      asOfMs: 1_750_000_000_000
    });

    expect(adverseReport.executionQualityRating).toBe("TOXIC");
    expect(adverseReport.recommendedAggressiveness).toBe("MORE_PASSIVE");
    expect(adverseReport.adverseSelectionScore).toBe(0.85);
    expect(adverseReport.forensicSummary).toContain("adverse selection");
  });

  it("E1: transmits Gemini API key in x-goog-api-key header and requires explicit simulateResponses flag", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (url: string, init: { headers: Record<string, string> }) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      headline: "Test Headline",
                      directionalBias: "neutral",
                      noveltyScore: 0.5,
                      confidenceScore: 0.8,
                      affectedInstruments: ["BTC-USDT-SWAP"],
                      tags: ["test"]
                    })
                  }
                ]
              }
            }
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25 }
        }),
        text: async () => ""
      };
    };

    // Even if apiKey contains "test" or "simulated", it must NOT silently simulate unless simulateResponses is true!
    const gateway = new GeminiLlmGateway({
      clock,
      getConfig: () => config.ai,
      getApiKey: () => "test-gemini-secret-api-key",
      fetchFn: mockFetch,
      simulateResponses: false
    });

    const analyst = new ContextAnalyst(gateway);
    await analyst.analyzeText({
      text: "Market conditions report.",
      source: "Wire",
      asOfMs: 1_750_000_000_000
    });

    // 1. Key must NOT be in URL query string
    expect(capturedUrl).not.toContain("?key=");
    expect(capturedUrl).not.toContain("test-gemini-secret-api-key");
    expect(capturedUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    );

    // 2. Key must be in x-goog-api-key header
    expect(capturedHeaders["x-goog-api-key"]).toBe("test-gemini-secret-api-key");
  });
});
