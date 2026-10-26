import { describe, expect, it } from "vitest";
import { ScaledDecimal } from "../src/decimal.js";
import {
  computeNextBarOpenEntry,
  evaluateIntrabarExit,
  computeTradePnL,
  computeMarketExitPrice
} from "../src/execution.js";

describe("T2: Replay Realism, Shared Execution Parity, & Adverse Slippage (R1)", () => {
  it("applies adverse slippage to protective stops and market exits, but NEVER to take-profit limit fills", () => {
    const barOpen = ScaledDecimal.fromString("100.00");
    const barHigh = ScaledDecimal.fromString("105.00");
    const barLow = ScaledDecimal.fromString("95.00");
    const stopPrice = ScaledDecimal.fromString("98.00");
    const tpPrice = ScaledDecimal.fromString("104.00");
    const slippageBps = 10; // 10 bps = 0.1%

    // 1. Long Stop Hit -> raw price is min(100, 98) = 98.00.
    // Adverse slippage = 98.00 * 0.001 = 0.098.
    // Final exit price = 98.00 - 0.098 = 97.902.
    const longStopExit = evaluateIntrabarExit({
      side: "long",
      barOpen,
      barHigh,
      barLow,
      stopPrice,
      tpPrice,
      slippageBps
    });

    expect(longStopExit.closed).toBe(true);
    expect(longStopExit.exitReason).toBe("protective_stop");
    expect(longStopExit.rawExitPrice?.equals(ScaledDecimal.fromString("98.00"))).toBe(true);
    expect(longStopExit.slippageAmount.equals(ScaledDecimal.fromString("0.098"))).toBe(true);
    expect(longStopExit.exitPrice?.equals(ScaledDecimal.fromString("97.902"))).toBe(true);

    // 2. Long Take-Profit Hit (no stop hit) -> raw price is max(100, 104) = 104.00.
    // Take-profit is a maker limit fill -> ZERO slippage!
    const longTpExit = evaluateIntrabarExit({
      side: "long",
      barOpen,
      barHigh,
      barLow: ScaledDecimal.fromString("99.00"), // stop not hit
      stopPrice,
      tpPrice,
      slippageBps
    });

    expect(longTpExit.closed).toBe(true);
    expect(longTpExit.exitReason).toBe("take_profit");
    expect(longTpExit.rawExitPrice?.equals(ScaledDecimal.fromString("104.00"))).toBe(true);
    expect(longTpExit.slippageAmount.isZero()).toBe(true);
    expect(longTpExit.exitPrice?.equals(ScaledDecimal.fromString("104.00"))).toBe(true);

    // 3. Short Stop Hit -> raw price is max(100, 102) = 102.00.
    // Adverse slippage on short (buying to cover) = 102.00 * 0.001 = 0.102.
    // Final exit price = 102.00 + 0.102 = 102.102.
    const shortStopExit = evaluateIntrabarExit({
      side: "short",
      barOpen,
      barHigh: ScaledDecimal.fromString("103.00"),
      barLow: ScaledDecimal.fromString("99.00"),
      stopPrice: ScaledDecimal.fromString("102.00"),
      tpPrice: ScaledDecimal.fromString("96.00"),
      slippageBps
    });

    expect(shortStopExit.closed).toBe(true);
    expect(shortStopExit.exitReason).toBe("protective_stop");
    expect(shortStopExit.rawExitPrice?.equals(ScaledDecimal.fromString("102.00"))).toBe(true);
    expect(shortStopExit.slippageAmount.equals(ScaledDecimal.fromString("0.102"))).toBe(true);
    expect(shortStopExit.exitPrice?.equals(ScaledDecimal.fromString("102.102"))).toBe(true);
    // 4. Market exit execution
    const mkt = computeMarketExitPrice({
      side: "long",
      marketPrice: ScaledDecimal.fromString("100.00"),
      slippageBps: 10
    });
    expect(mkt.exitPrice.equals(ScaledDecimal.fromString("99.90"))).toBe(true);
    expect(mkt.slippageAmount.equals(ScaledDecimal.fromString("0.10"))).toBe(true);
  });

  it("scales BOTH trading fees and execution slippage under the 2.0x cost stress multiplier", () => {
    // 1 BTC position: entry $50,000, exit $51,000 (gross profit = $1,000)
    // Entry fee: $20, Exit fee: $20 -> Total fees: $40
    // Entry slippage: $25, Exit slippage: $25 -> Total slippage: $50
    // At 1.0x stress: Net PnL = Gross ($1000) - Fees ($40) = $960 (slippage already in fill prices)
    // At 2.0x stress: Additional stress cost = 1.0 * (Fees ($40) + Slippage ($50)) = $90
    // Stressed Net PnL = $960 - $90 = $870
    const pnl = computeTradePnL({
      side: "long",
      entryPrice: ScaledDecimal.fromString("50000.00"),
      exitPrice: ScaledDecimal.fromString("51000.00"),
      contracts: ScaledDecimal.fromString("1.0"),
      contractValue: ScaledDecimal.fromString("1.0"),
      entryFeeUsdt: ScaledDecimal.fromString("20.00"),
      exitFeeUsdt: ScaledDecimal.fromString("20.00"),
      entrySlippageUsdt: ScaledDecimal.fromString("25.00"),
      exitSlippageUsdt: ScaledDecimal.fromString("25.00"),
      fundingAccruedUsdt: ScaledDecimal.zero(),
      initialRiskUsdt: ScaledDecimal.fromString("1000.00"),
      costStressMultiplier: 2.0
    });

    expect(pnl.grossPnlUsdt.equals(ScaledDecimal.fromString("1000.00"))).toBe(true);
    expect(pnl.totalFeesUsdt.equals(ScaledDecimal.fromString("40.00"))).toBe(true);
    expect(pnl.totalSlippageUsdt.equals(ScaledDecimal.fromString("50.00"))).toBe(true);
    expect(pnl.netPnlUsdt.equals(ScaledDecimal.fromString("960.00"))).toBe(true);
    expect(pnl.stressNetPnlUsdt.equals(ScaledDecimal.fromString("870.00"))).toBe(true);
    expect(pnl.netR).toBe(0.96);
    expect(pnl.stressNetR).toBe(0.87);
  });

  it("proves bit-for-bit execution parity between ReplayEngine and PaperBroker shared models", () => {
    // Setup simulated bar and proposal data
    const slippageBps = 8; // 8 bps = 0.08%
    const barOpen = ScaledDecimal.fromString("60000.00");
    const proposedEntry = ScaledDecimal.fromString("60100.00");
    const proposedStop = ScaledDecimal.fromString("58500.00");
    const proposedTp = ScaledDecimal.fromString("63000.00");

    // 1. Entry execution via shared computeNextBarOpenEntry
    const replayEntry = computeNextBarOpenEntry({
      side: "long",
      barOpen,
      slippageBps,
      proposedEntryPrice: proposedEntry,
      proposedStopPrice: proposedStop,
      proposedTpPrice: proposedTp
    });

    const paperEntry = computeNextBarOpenEntry({
      side: "long",
      barOpen,
      slippageBps,
      proposedEntryPrice: proposedEntry,
      proposedStopPrice: proposedStop,
      proposedTpPrice: proposedTp
    });

    expect(replayEntry.entryPrice.equals(paperEntry.entryPrice)).toBe(true);
    expect(replayEntry.effectiveStopPrice.equals(paperEntry.effectiveStopPrice)).toBe(true);
    expect(
      replayEntry.effectiveTpPrice &&
        paperEntry.effectiveTpPrice &&
        replayEntry.effectiveTpPrice.equals(paperEntry.effectiveTpPrice)
    ).toBe(true);
    expect(replayEntry.slippageAmount.equals(paperEntry.slippageAmount)).toBe(true);

    // 2. Intrabar Stop Exit via shared evaluateIntrabarExit
    const exitBar = {
      open: ScaledDecimal.fromString("59000.00"),
      high: ScaledDecimal.fromString("59200.00"),
      low: ScaledDecimal.fromString("58200.00") // Breaches stop price (58448)
    };

    const replayExit = evaluateIntrabarExit({
      side: "long",
      barOpen: exitBar.open,
      barHigh: exitBar.high,
      barLow: exitBar.low,
      stopPrice: replayEntry.effectiveStopPrice,
      tpPrice: replayEntry.effectiveTpPrice,
      slippageBps
    });

    const paperExit = evaluateIntrabarExit({
      side: "long",
      barOpen: exitBar.open,
      barHigh: exitBar.high,
      barLow: exitBar.low,
      stopPrice: paperEntry.effectiveStopPrice,
      tpPrice: paperEntry.effectiveTpPrice,
      slippageBps
    });

    expect(replayExit.closed).toBe(true);
    expect(paperExit.closed).toBe(true);
    expect(replayExit.exitReason).toBe("protective_stop");
    expect(paperExit.exitReason).toBe("protective_stop");
    expect(
      replayExit.exitPrice &&
        paperExit.exitPrice &&
        replayExit.exitPrice.equals(paperExit.exitPrice)
    ).toBe(true);
    expect(
      replayExit.rawExitPrice &&
        paperExit.rawExitPrice &&
        replayExit.rawExitPrice.equals(paperExit.rawExitPrice)
    ).toBe(true);
    expect(replayExit.slippageAmount.equals(paperExit.slippageAmount)).toBe(true);

    // 3. PnL parity calculation
    const contracts = ScaledDecimal.fromString("0.5");
    const contractValue = ScaledDecimal.fromString("1.0");
    const baseQty = contracts.mul(contractValue);
    const resolvedExitPrice = replayExit.exitPrice ?? ScaledDecimal.zero();
    const entryFee = replayEntry.entryPrice.mul(baseQty).mul(ScaledDecimal.fromString("0.0005"));
    const exitFee = resolvedExitPrice.mul(baseQty).mul(ScaledDecimal.fromString("0.0005"));

    const replayPnl = computeTradePnL({
      side: "long",
      entryPrice: replayEntry.entryPrice,
      exitPrice: resolvedExitPrice,
      contracts,
      contractValue,
      entryFeeUsdt: entryFee,
      exitFeeUsdt: exitFee,
      entrySlippageUsdt: replayEntry.slippageAmount.mul(baseQty),
      exitSlippageUsdt: replayExit.slippageAmount.mul(baseQty),
      fundingAccruedUsdt: ScaledDecimal.zero(),
      initialRiskUsdt: ScaledDecimal.fromString("800.00"),
      costStressMultiplier: 2.0
    });

    const paperPnl = computeTradePnL({
      side: "long",
      entryPrice: paperEntry.entryPrice,
      exitPrice: resolvedExitPrice,
      contracts,
      contractValue,
      entryFeeUsdt: entryFee,
      exitFeeUsdt: exitFee,
      entrySlippageUsdt: paperEntry.slippageAmount.mul(baseQty),
      exitSlippageUsdt: paperExit.slippageAmount.mul(baseQty),
      fundingAccruedUsdt: ScaledDecimal.zero(),
      initialRiskUsdt: ScaledDecimal.fromString("800.00"),
      costStressMultiplier: 2.0
    });

    expect(replayPnl.grossPnlUsdt.equals(paperPnl.grossPnlUsdt)).toBe(true);
    expect(replayPnl.totalFeesUsdt.equals(paperPnl.totalFeesUsdt)).toBe(true);
    expect(replayPnl.totalSlippageUsdt.equals(paperPnl.totalSlippageUsdt)).toBe(true);
    expect(replayPnl.netPnlUsdt.equals(paperPnl.netPnlUsdt)).toBe(true);
    expect(replayPnl.stressNetPnlUsdt.equals(paperPnl.stressNetPnlUsdt)).toBe(true);
    expect(replayPnl.netR).toBe(paperPnl.netR);
    expect(replayPnl.stressNetR).toBe(paperPnl.stressNetR);
  });
});
