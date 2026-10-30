import {
  SEALED_HOLDOUT_START_TS,
  ScaledDecimal,
  computeMarketExitPrice,
  computeNextBarOpenEntry,
  computeTradePnL,
  defaultInstrumentSpec,
  evaluateIntrabarExit,
  overlapsSealed2026Holdout,
  sizeByStopRisk,
  type ConfirmedBar,
  type FeatureSnapshot,
  type MarketDataRepository,
  type Proposal,
  type SettledFundingRate
} from "@keel/core";
import {
  BaselineChooser,
  isTighterStop,
  reconcilePairLegs,
  type PairSide,
  type Strategy
} from "@keel/strategy";
import { computeDeflatedSharpeRatio, getTimeframeAnnualizationPeriods } from "./index.js";
import { FUNDING_INTERVAL_MS, createInMemorySnapshots, updateTrackedDrawdown } from "./shared.js";

// ============================================================================
// The pair replay (ADR-0032). Both legs of a pair boat are replayed together, bar by bar, on one
// shared equity: each leg fills, stops, pays funding and exits exactly as a single-market replay
// would, and after every bar the pair rule (reconcilePairLegs) closes a leg left on its own.
// The live boat applies the same rule after the same bar, so a sea trial sees what the boat does.
// ============================================================================

export interface PairLegInput {
  readonly instrumentId: string;
  readonly strategy: Strategy;
}

export interface PairReplayInput {
  readonly legs: readonly [PairLegInput, PairLegInput];
  readonly fromTs: number;
  readonly toTs: number;
  readonly initialEquityUsdt: ScaledDecimal;
  readonly riskFractionPerTrade: number;
  readonly maxGrossLeverage: number;
  readonly takerFeeBps?: number | undefined;
  readonly halfSpreadBps?: number | undefined;
  readonly slippageBps?: number | undefined;
  readonly costStressMultiplier: number;
  readonly assumedFundingBpsPer8h?: number | undefined;
  readonly walkForwardFolds: number;
  readonly numTrials: number;
  readonly randomEntryPaths: number;
  readonly seed: number;
  readonly replayMinTrades?: number | undefined;
  readonly replayMinSharpe?: number | undefined;
  readonly replayMinDeflatedSharpeConfidence?: number | undefined;
}

/** Why a leg left the market. "pair-leg" is the pair rule closing a leg left on its own. */
export type PairLegExitReason =
  "stop" | "take-profit" | "signal-exit" | "time-stop" | "pair-leg" | "end-of-replay";

export interface PairLegTrade {
  readonly instrumentId: string;
  readonly side: PairSide;
  readonly entryTs: number;
  readonly exitTs: number;
  readonly entryPrice: ScaledDecimal;
  readonly exitPrice: ScaledDecimal;
  readonly contracts: ScaledDecimal;
  readonly netPnlUsdt: ScaledDecimal;
  readonly exitReason: PairLegExitReason;
}

/** One round trip of the pair: both legs (or the lone leg the pair rule closed) together. */
export interface PairTradeRecord {
  /** The first leg's side: "long" bought the first coin and sold the second. */
  readonly side: PairSide;
  readonly entryTs: number;
  readonly exitTs: number;
  readonly initialRiskUsdt: ScaledDecimal;
  readonly netPnlUsdt: ScaledDecimal;
  readonly netR: number;
  readonly stressNetR: number;
  readonly legs: readonly PairLegTrade[];
}

export interface PairEquityPoint {
  readonly ts: number;
  readonly equityUsdt: string;
  readonly drawdownPct: number;
}

export interface PairReplayResult {
  readonly netPnlUsdt: string;
  readonly totalFeesUsdt: string;
  readonly totalFundingUsdt: string;
  readonly sharpeRatio: number;
  readonly deflatedSharpeRatio: number;
  readonly totalTrades: number;
  readonly winRate: number;
  readonly avgR: number;
  readonly maxDrawdownPct: number;
  readonly fromTs: number;
  readonly toTs: number;
  readonly stressNetExpectancyR: number;
  readonly walkForwardOutOfSampleAvgR: number;
  readonly replayGatePassed: boolean;
  readonly randomEntryPercentile: number;
  /** A pair is market-neutral, so its benchmark is cash: no return, no Sharpe. */
  readonly buyAndHoldReturnPct: number;
  readonly buyAndHoldSharpeRatio: number;
  readonly trades: readonly PairTradeRecord[];
  readonly equityCurve: readonly PairEquityPoint[];
}

interface LegPosition {
  readonly side: PairSide;
  readonly entryTs: number;
  readonly entryIdx: number;
  readonly entryPrice: ScaledDecimal;
  stopPrice: ScaledDecimal;
  readonly takeProfitPrice: ScaledDecimal | null;
  readonly contracts: ScaledDecimal;
  readonly notionalUsdt: ScaledDecimal;
  readonly initialRiskUsdt: ScaledDecimal;
  readonly entryFeeUsdt: ScaledDecimal;
  readonly entrySlippageUsdt: ScaledDecimal;
  fundingUsdt: ScaledDecimal;
  lastFundingTs: number;
}

interface LegClose {
  readonly trade: PairLegTrade;
  readonly initialRiskUsdt: ScaledDecimal;
  readonly stressNetPnlUsdt: ScaledDecimal;
}

interface LegData {
  readonly instrumentId: string;
  readonly strategy: Strategy;
  readonly byCloseTs: ReadonlyMap<number, ConfirmedBar>;
  readonly fundingByCloseTs: ReadonlyMap<number, readonly SettledFundingRate[]>;
  readonly assumedFundingFraction: ScaledDecimal | null;
  readonly snapshot: (asOfMs: number) => FeatureSnapshot;
}

interface PairSimulation {
  readonly trades: readonly PairTradeRecord[];
  readonly equityCurve: readonly PairEquityPoint[];
  readonly periodicReturns: readonly number[];
  readonly netPnlUsdt: ScaledDecimal;
  readonly totalFeesUsdt: ScaledDecimal;
  readonly totalFundingUsdt: ScaledDecimal;
  readonly maxDrawdownPct: number;
  readonly netExpectancyR: number;
  readonly stressNetExpectancyR: number;
}

const dec = (value: number): ScaledDecimal => ScaledDecimal.fromString(value.toFixed(8));

function legData(
  repo: MarketDataRepository,
  leg: PairLegInput,
  bars: readonly ConfirmedBar[],
  assumedFundingBpsPer8h: number
): LegData {
  const first = bars[0];
  const last = bars[bars.length - 1];
  const funding =
    first && last
      ? repo.getSettledFundingInRange({
          instrumentId: leg.instrumentId,
          fromTs: first.openTs,
          toTs: last.closeTs
        })
      : [];
  const fundingByCloseTs = new Map<number, SettledFundingRate[]>();
  let f = 0;
  for (const bar of bars) {
    const list: SettledFundingRate[] = [];
    while (f < funding.length && (funding[f]?.fundingTs ?? Infinity) <= bar.closeTs) {
      const item = funding[f];
      if (item) list.push(item);
      f++;
    }
    if (list.length > 0) fundingByCloseTs.set(bar.closeTs, list);
  }
  const snapshot = createInMemorySnapshots({
    marketDataRepo: repo,
    instrumentId: leg.instrumentId,
    timeframe: "1H",
    requirements: leg.strategy.lookbacks,
    bars,
    settledFunding: funding,
    referenceMarkets: leg.strategy.referenceMarkets
  });
  if (!snapshot) throw new Error("A pair leg needs a single 1H lookback");
  return {
    instrumentId: leg.instrumentId,
    strategy: leg.strategy,
    byCloseTs: new Map(bars.map((b) => [b.closeTs, b])),
    fundingByCloseTs,
    assumedFundingFraction:
      funding.length === 0 && assumedFundingBpsPer8h > 0
        ? dec(assumedFundingBpsPer8h / 10_000)
        : null,
    snapshot
  };
}

/** Replays a pair over the first leg's bars (the clock), both legs on one equity. */
function simulatePair(params: {
  readonly clock: readonly ConfirmedBar[];
  readonly legs: readonly [LegData, LegData];
  readonly initialEquityUsdt: ScaledDecimal;
  readonly riskFraction: number;
  readonly maxLeverage: number;
  readonly slippageBps: number;
  readonly oneWayFeeBps: number;
  readonly costStressMultiplier: number;
}): PairSimulation {
  const chooser = new BaselineChooser();
  const feeFraction = dec(params.oneWayFeeBps / 10_000);
  const riskFraction = dec(params.riskFraction);
  const maxLeverage = dec(params.maxLeverage);
  let equity = params.initialEquityUsdt;
  let totalFees = ScaledDecimal.zero();
  let totalFunding = ScaledDecimal.zero();
  let peak = Number(equity.toString());
  let prev = peak;
  let maxDrawdownPct = 0;

  const active: [LegPosition | null, LegPosition | null] = [null, null];
  const pending: [Proposal | null, Proposal | null] = [null, null];
  let round: LegClose[] = [];
  const trades: PairTradeRecord[] = [];
  const equityCurve: PairEquityPoint[] = [];
  const periodicReturns: number[] = [];

  const finishRound = (): void => {
    if (active[0] || active[1] || round.length === 0) return;
    const risk = round.reduce((s, c) => s.add(c.initialRiskUsdt), ScaledDecimal.zero());
    const net = round.reduce((s, c) => s.add(c.trade.netPnlUsdt), ScaledDecimal.zero());
    const stress = round.reduce((s, c) => s.add(c.stressNetPnlUsdt), ScaledDecimal.zero());
    const riskNum = Math.max(0.01, Number(risk.toString()));
    const firstLeg = round.find((c) => c.trade.instrumentId === params.legs[0].instrumentId);
    const lone = round[0];
    trades.push({
      side: firstLeg ? firstLeg.trade.side : lone?.trade.side === "long" ? "short" : "long",
      entryTs: Math.min(...round.map((c) => c.trade.entryTs)),
      exitTs: Math.max(...round.map((c) => c.trade.exitTs)),
      initialRiskUsdt: risk,
      netPnlUsdt: net,
      netR: Number((Number(net.toString()) / riskNum).toFixed(6)),
      stressNetR: Number((Number(stress.toString()) / riskNum).toFixed(6)),
      legs: round.map((c) => c.trade)
    });
    round = [];
  };

  const closeLeg = (
    i: 0 | 1,
    exitTs: number,
    exitPrice: ScaledDecimal,
    exitSlippageUsdt: ScaledDecimal,
    reason: PairLegExitReason
  ): void => {
    const pos = active[i];
    if (!pos) return;
    const leg = params.legs[i];
    const spec = defaultInstrumentSpec(leg.instrumentId);
    const exitFee = exitPrice.mul(pos.contracts.mul(spec.contractValue)).mul(feeFraction);
    const pnl = computeTradePnL({
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      contracts: pos.contracts,
      contractValue: spec.contractValue,
      entryFeeUsdt: pos.entryFeeUsdt,
      exitFeeUsdt: exitFee,
      entrySlippageUsdt: pos.entrySlippageUsdt,
      exitSlippageUsdt,
      fundingAccruedUsdt: pos.fundingUsdt,
      initialRiskUsdt: pos.initialRiskUsdt,
      costStressMultiplier: params.costStressMultiplier
    });
    equity = equity.add(pnl.netPnlUsdt);
    totalFees = totalFees.add(pnl.totalFeesUsdt);
    totalFunding = totalFunding.add(pos.fundingUsdt);
    round.push({
      trade: {
        instrumentId: leg.instrumentId,
        side: pos.side,
        entryTs: pos.entryTs,
        exitTs,
        entryPrice: pos.entryPrice,
        exitPrice,
        contracts: pos.contracts,
        netPnlUsdt: pnl.netPnlUsdt,
        exitReason: reason
      },
      initialRiskUsdt: pos.initialRiskUsdt,
      stressNetPnlUsdt: pnl.stressNetPnlUsdt
    });
    active[i] = null;
  };

  const closeAtMarket = (i: 0 | 1, bar: ConfirmedBar, reason: PairLegExitReason): void => {
    const pos = active[i];
    if (!pos) return;
    const spec = defaultInstrumentSpec(params.legs[i].instrumentId);
    const exit = computeMarketExitPrice({
      side: pos.side,
      marketPrice: ScaledDecimal.fromString(bar.close),
      slippageBps: params.slippageBps
    });
    closeLeg(
      i,
      bar.closeTs,
      exit.exitPrice,
      exit.slippageAmount.mul(pos.contracts.mul(spec.contractValue)),
      reason
    );
  };

  const last = params.clock.length - 1;
  for (let idx = 0; idx <= last; idx++) {
    const clockBar = params.clock[idx];
    if (!clockBar) continue;
    const t = clockBar.closeTs;
    const barsNow: [ConfirmedBar | undefined, ConfirmedBar | undefined] = [
      params.legs[0].byCloseTs.get(t),
      params.legs[1].byCloseTs.get(t)
    ];

    for (const i of [0, 1] as const) {
      const leg = params.legs[i];
      const bar = barsNow[i];
      if (!bar) continue;
      const spec = defaultInstrumentSpec(leg.instrumentId);
      const barOpen = ScaledDecimal.fromString(bar.open);
      const barClose = ScaledDecimal.fromString(bar.close);

      // 1. A waiting entry fills at this bar's open, sized off the pair's equity
      const waiting = pending[i];
      if (waiting && !active[i]) {
        const exec = computeNextBarOpenEntry({
          side: waiting.side,
          barOpen,
          slippageBps: params.slippageBps,
          proposedEntryPrice: ScaledDecimal.fromString(waiting.entryPrice),
          proposedStopPrice: ScaledDecimal.fromString(waiting.protectiveStopPrice),
          proposedTpPrice: waiting.takeProfitPrice
            ? ScaledDecimal.fromString(waiting.takeProfitPrice)
            : null
        });
        const sizing = sizeByStopRisk({
          instrument: spec,
          side: waiting.side,
          strategyEquityQuote: equity,
          riskFraction,
          entryPrice: exec.entryPrice,
          stopPrice: exec.effectiveStopPrice,
          maxGrossLeverage: maxLeverage
        });
        const other = active[i === 0 ? 1 : 0];
        // Both legs share the boat's gross leverage cap, as the Risk Engine checks live
        const withinCap =
          sizing.ok &&
          (other?.notionalUsdt ?? ScaledDecimal.zero())
            .add(sizing.notionalQuote)
            .lte(equity.mul(maxLeverage));
        if (sizing.ok && withinCap && sizing.contracts.isPositive()) {
          active[i] = {
            side: waiting.side,
            entryTs: bar.openTs,
            entryIdx: idx,
            entryPrice: exec.entryPrice,
            stopPrice: sizing.effectiveStopPrice,
            takeProfitPrice: exec.effectiveTpPrice,
            contracts: sizing.contracts,
            notionalUsdt: sizing.notionalQuote,
            initialRiskUsdt: sizing.sizedRiskQuote,
            entryFeeUsdt: sizing.notionalQuote.mul(feeFraction),
            entrySlippageUsdt: exec.slippageAmount.mul(sizing.contracts.mul(spec.contractValue)),
            fundingUsdt: ScaledDecimal.zero(),
            lastFundingTs: bar.openTs
          };
        }
        pending[i] = null;
      }

      const pos = active[i];
      if (pos) {
        // 2. Funding settled this hour, then the protective stop and target, gap-aware
        const settled = leg.fundingByCloseTs.get(bar.closeTs);
        const markNotional = barClose.mul(pos.contracts.mul(spec.contractValue));
        if (settled) {
          for (const f of settled) {
            if (f.fundingTs <= pos.lastFundingTs) continue;
            const payment = markNotional.mul(ScaledDecimal.fromString(f.fundingRate));
            pos.fundingUsdt =
              pos.side === "long" ? pos.fundingUsdt.sub(payment) : pos.fundingUsdt.add(payment);
            pos.lastFundingTs = f.fundingTs;
          }
        } else if (leg.assumedFundingFraction && bar.closeTs % FUNDING_INTERVAL_MS === 0) {
          pos.fundingUsdt = pos.fundingUsdt.sub(markNotional.mul(leg.assumedFundingFraction));
          pos.lastFundingTs = bar.closeTs;
        }
        const exit = evaluateIntrabarExit({
          side: pos.side,
          barOpen,
          barHigh: ScaledDecimal.fromString(bar.high),
          barLow: ScaledDecimal.fromString(bar.low),
          stopPrice: pos.stopPrice,
          tpPrice: pos.takeProfitPrice,
          slippageBps: params.slippageBps
        });
        if (exit.closed && exit.exitPrice && exit.exitReason) {
          closeLeg(
            i,
            bar.closeTs,
            exit.exitPrice,
            exit.slippageAmount.mul(pos.contracts.mul(spec.contractValue)),
            exit.exitReason === "protective_stop" ? "stop" : "take-profit"
          );
        }
      }

      // 3. Exit rules and the time limit, decided on this confirmed bar
      const held = active[i];
      if (held && leg.strategy.manage && idx < last) {
        const instruction = leg.strategy.manage(
          {
            side: held.side,
            entryPrice: held.entryPrice.toString(),
            protectiveStopPrice: held.stopPrice.toString(),
            barsHeld: idx - held.entryIdx + 1
          },
          leg.snapshot(bar.closeTs)
        );
        if (instruction.kind === "exit") {
          closeAtMarket(i, bar, instruction.reason === "time_stop" ? "time-stop" : "signal-exit");
        } else if (
          instruction.newStopPrice !== undefined &&
          isTighterStop(held.side, held.stopPrice.toString(), instruction.newStopPrice)
        ) {
          held.stopPrice = ScaledDecimal.fromString(instruction.newStopPrice);
        }
      }

      // 4. Flat legs look for an entry, to fill at the next bar's open
      if (!active[i] && !pending[i] && idx < last) {
        const chosen = chooser.choose([leg.strategy.evaluate(leg.snapshot(bar.closeTs))]);
        if (chosen) pending[i] = chosen;
      }
    }

    // 5. The pair rule: never one leg without the other, entries only as a matched pair
    const rule = reconcilePairLegs(
      { open: active[0]?.side ?? null, pending: pending[0]?.side ?? null },
      { open: active[1]?.side ?? null, pending: pending[1]?.side ?? null }
    );
    for (const i of rule.closeLegs) {
      const bar = barsNow[i];
      if (bar) closeAtMarket(i, bar, "pair-leg");
    }
    if (rule.cancelPending) {
      pending[0] = null;
      pending[1] = null;
    }
    finishRound();

    // 6. Mark both legs to market for the equity curve and the worst dip
    let closeEquity = equity;
    let worstEquity = equity;
    for (const i of [0, 1] as const) {
      const pos = active[i];
      const bar = barsNow[i];
      if (!pos || !bar) continue;
      const qty = pos.contracts.mul(
        defaultInstrumentSpec(params.legs[i].instrumentId).contractValue
      );
      const mark = (price: ScaledDecimal): ScaledDecimal =>
        (pos.side === "long" ? price.sub(pos.entryPrice) : pos.entryPrice.sub(price))
          .mul(qty)
          .sub(pos.entryFeeUsdt)
          .sub(price.mul(qty).mul(feeFraction))
          .add(pos.fundingUsdt);
      closeEquity = closeEquity.add(mark(ScaledDecimal.fromString(bar.close)));
      worstEquity = worstEquity.add(
        mark(ScaledDecimal.fromString(pos.side === "long" ? bar.low : bar.high))
      );
    }
    const eq = Number(closeEquity.toString());
    const dd = updateTrackedDrawdown({
      peakEquityNum: peak,
      closeEquityNum: eq,
      worstIntraEquityNum: Number(worstEquity.toString()),
      currentMaxDrawdownPct: maxDrawdownPct
    });
    peak = dd.newPeakEquityNum;
    maxDrawdownPct = dd.newMaxDrawdownPct;
    equityCurve.push({
      ts: t,
      equityUsdt: closeEquity.toString(),
      drawdownPct: Number((peak > 0 ? ((peak - eq) / peak) * 100 : 0).toFixed(4))
    });
    periodicReturns.push(prev > 0 ? (eq - prev) / prev : 0);
    prev = eq;
  }

  // Anything still open leaves at the last close
  for (const i of [0, 1] as const) {
    const lastBar = [...params.legs[i].byCloseTs.values()].pop();
    if (active[i] && lastBar) closeAtMarket(i, lastBar, "end-of-replay");
  }
  finishRound();

  const mean = (xs: readonly number[]): number =>
    xs.length > 0 ? Number((xs.reduce((a, v) => a + v, 0) / xs.length).toFixed(6)) : 0;
  return {
    trades,
    equityCurve,
    periodicReturns,
    netPnlUsdt: equity.sub(params.initialEquityUsdt),
    totalFeesUsdt: totalFees,
    totalFundingUsdt: totalFunding,
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
    netExpectancyR: mean(trades.map((t) => t.netR)),
    stressNetExpectancyR: mean(trades.map((t) => t.stressNetR))
  };
}

/** A small seeded generator, so the random-entry baseline is the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where the pair's trades rank among random pair trades: the same number of trades, held for the
 * same average time, on random hours and random sides, each paying four fills of costs. Trades are
 * compared by their spread return, the move of the first coin against the second.
 */
function randomPairPercentile(params: {
  readonly closes: readonly (readonly [number, number])[];
  readonly closeTs: readonly number[];
  readonly trades: readonly PairTradeRecord[];
  readonly paths: number;
  readonly costFraction: number;
  readonly seed: number;
}): number {
  const n = params.trades.length;
  const len = params.closes.length;
  if (n === 0 || len < 3 || params.paths <= 0) return 0;
  const indexOf = (ts: number): number => {
    let lo = 0;
    let hi = len - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((params.closeTs[mid] ?? 0) < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const spreadReturn = (from: number, to: number, side: PairSide): number => {
    const [a0, b0] = params.closes[from] ?? [1, 1];
    const [a1, b1] = params.closes[to] ?? [1, 1];
    const move = Math.log(a1 / a0) - Math.log(b1 / b0);
    return (side === "long" ? move : -move) - 4 * params.costFraction;
  };
  const actual =
    params.trades.reduce(
      (acc, t) => acc + spreadReturn(indexOf(t.entryTs), indexOf(t.exitTs), t.side),
      0
    ) / n;
  const hold = Math.max(
    1,
    Math.round(params.trades.reduce((acc, t) => acc + (t.exitTs - t.entryTs), 0) / n / 3_600_000)
  );
  if (len <= hold + 1) return 0;
  const rand = mulberry32(params.seed);
  let below = 0;
  for (let p = 0; p < params.paths; p++) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const from = Math.floor(rand() * (len - hold - 1));
      sum += spreadReturn(from, from + hold, rand() < 0.5 ? "long" : "short");
    }
    if (sum / n < actual) below++;
  }
  return (100 * below) / params.paths;
}

/**
 * Replays a pair boat over a window and measures it the way the sea trial measures any boat:
 * Sharpe and luck on the hourly equity curve, cost stress from the trades, walk-forward folds
 * re-run on later stretches it was not judged on, and a random-entry baseline.
 */
export function runPairReplay(
  repo: MarketDataRepository,
  input: PairReplayInput
): PairReplayResult {
  if (input.toTs > SEALED_HOLDOUT_START_TS || overlapsSealed2026Holdout(input.fromTs, input.toTs)) {
    throw new Error("Sealed holdout violation: a pair replay never reads the sealed holdouts");
  }
  const slippageBps = input.slippageBps ?? 3;
  const oneWayFeeBps = (input.takerFeeBps ?? 5) + (input.halfSpreadBps ?? 2);
  const barsOf = (leg: PairLegInput): ConfirmedBar[] => [
    ...repo.getConfirmedBarsInRange({
      instrumentId: leg.instrumentId,
      timeframe: "1H",
      fromOpenTs: input.fromTs,
      toCloseTs: input.toTs
    })
  ];
  const bars = [barsOf(input.legs[0]), barsOf(input.legs[1])] as const;
  const window = (from: number, to: number): PairSimulation => {
    const slice = (b: readonly ConfirmedBar[]) =>
      b.filter((x) => x.openTs >= from && x.closeTs <= to);
    const a = slice(bars[0]);
    const b = slice(bars[1]);
    const legs = [
      legData(repo, input.legs[0], a, input.assumedFundingBpsPer8h ?? 0),
      legData(repo, input.legs[1], b, input.assumedFundingBpsPer8h ?? 0)
    ] as const;
    return simulatePair({
      clock: a,
      legs,
      initialEquityUsdt: input.initialEquityUsdt,
      riskFraction: input.riskFractionPerTrade,
      maxLeverage: input.maxGrossLeverage,
      slippageBps,
      oneWayFeeBps,
      costStressMultiplier: input.costStressMultiplier
    });
  };

  const main = window(input.fromTs, input.toTs);
  const dsr = computeDeflatedSharpeRatio({
    periodicReturns: main.periodicReturns,
    annualizationFactor: Math.sqrt(getTimeframeAnnualizationPeriods("1H")),
    numTrials: Math.max(1, input.numTrials)
  });

  // Walk-forward: each later fold replayed on its own, warm-up read as of its first bar
  let oosR = 0;
  let oosSufficient = false;
  const folds = input.walkForwardFolds;
  const clock = bars[0];
  if (folds > 0 && clock.length > 0) {
    const n = Math.max(2, folds);
    const foldLength = Math.floor(clock.length / n);
    const oos: number[] = [];
    for (let f = 1; f < n && foldLength > 30; f++) {
      const start = clock[f * foldLength];
      const end = clock[f === n - 1 ? clock.length - 1 : (f + 1) * foldLength - 1];
      if (start && end) oos.push(...window(start.openTs, end.closeTs).trades.map((t) => t.netR));
    }
    if (oos.length > 0) {
      oosSufficient = true;
      oosR = Number((oos.reduce((a, v) => a + v, 0) / oos.length).toFixed(6));
    }
  }

  const second = new Map(bars[1].map((b) => [b.closeTs, Number(b.close)]));
  const paired = clock.filter((b) => second.has(b.closeTs));
  const randomEntryPercentile = randomPairPercentile({
    closes: paired.map((b) => [Number(b.close), second.get(b.closeTs) ?? 1] as const),
    closeTs: paired.map((b) => b.closeTs),
    trades: main.trades,
    paths: input.randomEntryPaths,
    costFraction: (oneWayFeeBps + slippageBps) / 10_000,
    seed: input.seed
  });

  const wins = main.trades.filter((t) => t.netR > 0).length;
  const totalTrades = main.trades.length;
  const sharpe = dsr.sharpeRatio;
  const replayGatePassed =
    oosSufficient &&
    totalTrades >= (input.replayMinTrades ?? 100) &&
    main.stressNetExpectancyR > 0 &&
    oosR >= 0 &&
    sharpe >= (input.replayMinSharpe ?? 1) &&
    dsr.deflatedSharpeRatio >= (input.replayMinDeflatedSharpeConfidence ?? 0.8) &&
    sharpe > 0 &&
    main.maxDrawdownPct <= 25;

  return {
    netPnlUsdt: main.netPnlUsdt.toString(),
    totalFeesUsdt: main.totalFeesUsdt.toString(),
    totalFundingUsdt: main.totalFundingUsdt.toString(),
    sharpeRatio: sharpe,
    deflatedSharpeRatio: dsr.deflatedSharpeRatio,
    totalTrades,
    winRate: totalTrades > 0 ? Number((wins / totalTrades).toFixed(4)) : 0,
    avgR: main.netExpectancyR,
    maxDrawdownPct: main.maxDrawdownPct,
    fromTs: input.fromTs,
    toTs: input.toTs,
    stressNetExpectancyR: main.stressNetExpectancyR,
    walkForwardOutOfSampleAvgR: oosR,
    replayGatePassed,
    randomEntryPercentile,
    buyAndHoldReturnPct: 0,
    buyAndHoldSharpeRatio: 0,
    trades: main.trades,
    equityCurve: main.equityCurve
  };
}
