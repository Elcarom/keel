import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FIELD_REGISTRY,
  KeelConfigSchema,
  computeConfigHash,
  createDefaultConfig,
  diffConfigs,
  flattenConfigPaths
} from "../src/index.js";

describe("@keel/core — Master Config Schema Registry (M0-2)", () => {
  it("parses default configuration matching ADR-0002, ADR-0003, and ADR-0007 defaults", () => {
    const cfg = createDefaultConfig();

    expect(cfg.system.executionMode).toBe("Paper");
    expect(cfg.system.port).toBe(8080);
    expect(cfg.system.sseHeartbeatMs).toBe(15000);
    expect(cfg.system.shutdownPolicy).toBe("hold");

    // Strategy & Portfolio Risk defaults (ADR-0002)
    expect(cfg.risk.paperPortfolioEquityUsdt).toBe(10000);
    expect(cfg.risk.strategy.riskPerTradePct).toBe(0.75);
    expect(cfg.risk.strategy.maxGrossLeverage).toBe(2.0);
    expect(cfg.risk.strategy.dailyLossStopPct).toBe(3.0);
    expect(cfg.risk.strategy.weeklyLossStopPct).toBe(6.0);
    expect(cfg.risk.strategy.maxDrawdownPct).toBe(15.0);
    expect(cfg.risk.portfolio.maxGrossLeverage).toBe(2.0);
    expect(cfg.risk.portfolio.maxNetDirectionalExposure).toBe(1.25);
    expect(cfg.risk.portfolio.maxSingleInstrumentExposure).toBe(1.0);
    expect(cfg.risk.portfolio.dailyLossStopPct).toBe(4.0);
    expect(cfg.risk.portfolio.maxDrawdownKillSwitchPct).toBe(12.0);

    // Promotion Ladder defaults (ADR-0007)
    expect(cfg.promotionLadder.replayMinTrades).toBe(150);
    expect(cfg.promotionLadder.replayMinDeflatedSharpeConfidence).toBe(0.9);
    expect(cfg.promotionLadder.replayCostStressMultiplier).toBe(2.0);
    expect(cfg.promotionLadder.aiMinDisagreementSample).toBe(50);
    expect(cfg.promotionLadder.liveDemotionDrawdownPct).toBe(12.0);

    // AI Gateway defaults (Gemini only, $15/mo, $0.75/day, per-feature sub-budgets)
    expect(cfg.ai.provider).toBe("gemini");
    expect(cfg.ai.monthlyBudgetUsd).toBe(15.0);
    expect(cfg.ai.dailyBudgetUsd).toBe(0.75);
    expect(cfg.ai.subBudgets).toEqual({
      contextAnalystPct: 40,
      shadowAdvisorPct: 30,
      strategyLabPct: 20,
      postTradeAndCopilotPct: 10
    });
  });

  it("rejects risk settings that exceed hard ceilings (riskPerTradePct > 1.5% or leverage > 3.0x)", () => {
    const base = createDefaultConfig();
    const invalidRisk = {
      ...base,
      risk: {
        ...base.risk,
        strategy: {
          ...base.risk.strategy,
          riskPerTradePct: 2.5
        }
      }
    };
    expect(KeelConfigSchema.safeParse(invalidRisk).success).toBe(false);

    const invalidLeverage = {
      ...base,
      risk: {
        ...base.risk,
        strategy: {
          ...base.risk.strategy,
          maxGrossLeverage: 5.0
        }
      }
    };
    expect(KeelConfigSchema.safeParse(invalidLeverage).success).toBe(false);
  });

  it("registers 100% of leaf paths in KeelConfigSchema with key, label, helpText, defaultValue, and ConfigRiskClass", () => {
    const defaults = createDefaultConfig();
    const flatDefaults = flattenConfigPaths(defaults);
    const registryByPath = new Map(CONFIG_FIELD_REGISTRY.map((f) => [f.path, f]));

    expect(CONFIG_FIELD_REGISTRY.length).toBe(flatDefaults.size);

    for (const [path, expectedDefault] of flatDefaults.entries()) {
      const meta = registryByPath.get(path);
      expect(meta, `Missing CONFIG_FIELD_REGISTRY entry for "${path}"`).toBeDefined();
      expect(meta?.key).toBe(path);
      expect(meta?.label.length).toBeGreaterThan(0);
      expect(meta?.helpText.length).toBeGreaterThan(0);
      expect(meta?.defaultValue).toEqual(expectedDefault);
      expect(["safe", "confirm", "restart-required", "locked-in-live"]).toContain(meta?.riskClass);
    }
  });

  it("computes a canonical SHA-256 configHash invariant to key ordering (fast-check)", () => {
    const cfg = createDefaultConfig();
    const expectedHash = computeConfigHash(cfg);
    expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (seed) => {
        const reordered = {
          ai: { ...cfg.ai, subBudgets: { ...cfg.ai.subBudgets } },
          notifications: { ...cfg.notifications },
          promotionLadder: { ...cfg.promotionLadder },
          risk: {
            portfolio: { ...cfg.risk.portfolio },
            strategy: { ...cfg.risk.strategy },
            liveRampMultipliers: [...cfg.risk.liveRampMultipliers] as [number, number, number],
            paperPortfolioEquityUsdt: cfg.risk.paperPortfolioEquityUsdt
          },
          system: { ...cfg.system }
        };
        expect(computeConfigHash(reordered)).toBe(expectedHash);

        const mutated = {
          ...reordered,
          ai: { ...reordered.ai, monthlyBudgetUsd: 15 + seed }
        };
        expect(computeConfigHash(mutated)).not.toBe(expectedHash);
      })
    );
  });

  it("diffs configuration changes and blocks locked-in-live fields during Live or Live-Ramp modes", () => {
    const before = createDefaultConfig();
    const after = {
      ...before,
      risk: {
        ...before.risk,
        portfolio: {
          ...before.risk.portfolio,
          maxDrawdownKillSwitchPct: 10.0 // locked-in-live field
        }
      }
    };

    const paperDiff = diffConfigs(before, after, "Paper");
    expect(paperDiff.allowed).toBe(true);
    expect(paperDiff.highestRiskClass).toBe("locked-in-live");
    expect(paperDiff.changes).toHaveLength(1);
    expect(paperDiff.changes[0]?.path).toBe("risk.portfolio.maxDrawdownKillSwitchPct");

    const liveDiff = diffConfigs(before, after, "Live");
    expect(liveDiff.allowed).toBe(false);
    expect(liveDiff.blockedPaths).toContain("risk.portfolio.maxDrawdownKillSwitchPct");
  });
});
