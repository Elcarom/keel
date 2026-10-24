import {
  ScaledDecimal,
  sha256Hex,
  type BarTimeframe,
  type ConfirmedBar,
  type FeatureSnapshot,
  type LookbackRequirement,
  type Proposal,
  type ProposalMenu
} from "@keel/core";

export interface Strategy {
  readonly id: string;
  readonly strategyId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly parameterHash: string;
  readonly lookbacks: LookbackRequirement;
  readonly lookbackRequirements: LookbackRequirement;
  evaluate(snapshot: FeatureSnapshot): ProposalMenu;
}

function toFixedDecimalString(value: number, decimals = 2): string {
  return ScaledDecimal.fromString(value.toFixed(decimals)).toString();
}

function computeTrueRange(bar: ConfirmedBar, prevClose: string): number {
  const high = Number(bar.high);
  const low = Number(bar.low);
  const prev = Number(prevClose);
  return Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
}

function computeAtr(bars: readonly ConfirmedBar[], length: number): number {
  if (bars.length < 2) {
    const single = bars[0];
    if (!single) return 10;
    return Math.max(1, Number(single.high) - Number(single.low));
  }
  const slice = bars.slice(-Math.min(bars.length, length + 1));
  let sumTr = 0;
  let count = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const cur = slice[i];
    const prev = slice[i - 1];
    if (cur && prev) {
      sumTr += computeTrueRange(cur, prev.close);
      count += 1;
    }
  }
  return Math.max(1, count > 0 ? sumTr / count : 10);
}

function buildProtectiveLevels(params: {
  side: "long" | "short";
  entryPriceStr: string;
  stopDistancePoints: number;
  rewardMultiple: number;
}): {
  protectiveStopPrice: string;
  takeProfitPrice: string;
} {
  const entry = Number(params.entryPriceStr);
  const safeDist = Math.max(1, Math.min(entry * 0.25, params.stopDistancePoints));
  const rewardDist = safeDist * Math.max(1, params.rewardMultiple);

  if (params.side === "long") {
    const stopVal = Math.max(0.01, entry - safeDist);
    const tpVal = entry + rewardDist;
    return {
      protectiveStopPrice: toFixedDecimalString(stopVal, 2),
      takeProfitPrice: toFixedDecimalString(tpVal, 2)
    };
  }
  const stopVal = entry + safeDist;
  const tpVal = Math.max(0.01, entry - rewardDist);
  return {
    protectiveStopPrice: toFixedDecimalString(stopVal, 2),
    takeProfitPrice: toFixedDecimalString(tpVal, 2)
  };
}

export interface DonchianTrendOptions {
  readonly timeframe?: BarTimeframe | undefined;
  readonly channelLength?: number | undefined;
  readonly atrStopMultiplier?: number | undefined;
  readonly rewardMultiple?: number | undefined;
}

export class DonchianTrendStrategy implements Strategy {
  public readonly id = "donchian-trend-v1";
  public readonly strategyId = "donchian-trend-v1";
  public readonly version = "1.0.0";
  public readonly name = "Donchian Trend Breakout v1";
  public readonly description = "20-bar Donchian channel breakout with 2x ATR protective stops.";
  public readonly parameterHash: string;
  public readonly lookbacks: LookbackRequirement;
  public readonly lookbackRequirements: LookbackRequirement;
  private readonly timeframe: BarTimeframe;
  private readonly channelLength: number;
  private readonly atrStopMultiplier: number;
  private readonly rewardMultiple: number;

  public constructor(options: DonchianTrendOptions = {}) {
    this.timeframe = options.timeframe ?? "1H";
    this.channelLength = options.channelLength ?? 20;
    this.atrStopMultiplier = options.atrStopMultiplier ?? 2.0;
    this.rewardMultiple = options.rewardMultiple ?? 2.5;
    this.parameterHash = sha256Hex(
      JSON.stringify({
        strategyId: this.strategyId,
        version: this.version,
        timeframe: this.timeframe,
        channelLength: this.channelLength,
        atrStopMultiplier: this.atrStopMultiplier,
        rewardMultiple: this.rewardMultiple
      })
    );
    this.lookbacks = {
      [this.timeframe]: this.channelLength + 2
    };
    this.lookbackRequirements = this.lookbacks;
  }

  public evaluate(snapshot: FeatureSnapshot): ProposalMenu {
    const bars = snapshot.barsByTimeframe[this.timeframe] ?? [];
    if (bars.length < this.channelLength + 1) {
      return {
        instrumentId: snapshot.instrumentId,
        asOfMs: snapshot.asOfMs,
        strategyId: this.strategyId,
        strategyVersion: this.version,
        proposals: [],
        standDownReason: `insufficient_lookback_${this.timeframe}`
      };
    }

    const latest = bars[bars.length - 1];
    if (!latest) {
      return {
        instrumentId: snapshot.instrumentId,
        asOfMs: snapshot.asOfMs,
        strategyId: this.strategyId,
        strategyVersion: this.version,
        proposals: [],
        standDownReason: `insufficient_lookback_${this.timeframe}`
      };
    }
    const priorWindow = bars.slice(-(this.channelLength + 1), -1);
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (const bar of priorWindow) {
      const h = Number(bar.high);
      const l = Number(bar.low);
      if (h > highestHigh) highestHigh = h;
      if (l < lowestLow) lowestLow = l;
    }

    const closeNum = Number(latest.close);
    const atr = computeAtr(bars, this.channelLength);
    const stopDistancePoints = Math.max(1, atr * this.atrStopMultiplier);

    const proposals: Proposal[] = [];
    if (closeNum > highestHigh) {
      const breakoutMagnitude = (closeNum - highestHigh) / Math.max(1, atr);
      const convictionScore = Number(
        Math.min(0.95, 0.55 + Math.min(0.35, breakoutMagnitude * 0.15)).toFixed(4)
      );
      const levels = buildProtectiveLevels({
        side: "long",
        entryPriceStr: latest.close,
        stopDistancePoints,
        rewardMultiple: this.rewardMultiple
      });
      proposals.push({
        proposalId: sha256Hex(
          `${this.strategyId}:${snapshot.instrumentId}:${snapshot.asOfMs}:long`
        ).slice(0, 16),
        strategyId: this.strategyId,
        strategyVersion: this.version,
        instrumentId: snapshot.instrumentId,
        side: "long",
        entryPrice: latest.close,
        protectiveStopPrice: levels.protectiveStopPrice,
        takeProfitPrice: levels.takeProfitPrice,
        convictionScore,
        rationale: `Donchian ${this.channelLength}-bar upside breakout above ${highestHigh.toFixed(2)} (ATR=${atr.toFixed(2)})`,
        tags: ["trend", "donchian", this.timeframe]
      });
    } else if (closeNum < lowestLow) {
      const breakoutMagnitude = (lowestLow - closeNum) / Math.max(1, atr);
      const convictionScore = Number(
        Math.min(0.95, 0.55 + Math.min(0.35, breakoutMagnitude * 0.15)).toFixed(4)
      );
      const levels = buildProtectiveLevels({
        side: "short",
        entryPriceStr: latest.close,
        stopDistancePoints,
        rewardMultiple: this.rewardMultiple
      });
      proposals.push({
        proposalId: sha256Hex(
          `${this.strategyId}:${snapshot.instrumentId}:${snapshot.asOfMs}:short`
        ).slice(0, 16),
        strategyId: this.strategyId,
        strategyVersion: this.version,
        instrumentId: snapshot.instrumentId,
        side: "short",
        entryPrice: latest.close,
        protectiveStopPrice: levels.protectiveStopPrice,
        takeProfitPrice: levels.takeProfitPrice,
        convictionScore,
        rationale: `Donchian ${this.channelLength}-bar downside breakdown below ${lowestLow.toFixed(2)} (ATR=${atr.toFixed(2)})`,
        tags: ["trend", "donchian", this.timeframe]
      });
    }

    return {
      instrumentId: snapshot.instrumentId,
      asOfMs: snapshot.asOfMs,
      strategyId: this.strategyId,
      strategyVersion: this.version,
      proposals,
      ...(proposals.length === 0 ? { standDownReason: "inside_donchian_channel" } : {})
    };
  }
}

export interface VolNormalizedMeanReversionOptions {
  readonly timeframe?: BarTimeframe | undefined;
  readonly lookbackBars?: number | undefined;
  readonly entryZScore?: number | undefined;
  readonly atrStopMultiplier?: number | undefined;
  readonly rewardMultiple?: number | undefined;
}

export class VolNormalizedMeanReversionStrategy implements Strategy {
  public readonly id = "vol-mean-reversion-v1";
  public readonly strategyId = "vol-mean-reversion-v1";
  public readonly version = "1.0.0";
  public readonly name = "Vol-Normalized Mean Reversion v1";
  public readonly description = "Z-score mean-reversion fade with volatility-normalized stops.";
  public readonly parameterHash: string;
  public readonly lookbacks: LookbackRequirement;
  public readonly lookbackRequirements: LookbackRequirement;
  private readonly timeframe: BarTimeframe;
  private readonly lookbackBars: number;
  private readonly entryZScore: number;
  private readonly atrStopMultiplier: number;
  private readonly rewardMultiple: number;

  public constructor(options: VolNormalizedMeanReversionOptions = {}) {
    this.timeframe = options.timeframe ?? "1H";
    this.lookbackBars = options.lookbackBars ?? 20;
    this.entryZScore = options.entryZScore ?? 1.6;
    this.atrStopMultiplier = options.atrStopMultiplier ?? 1.8;
    this.rewardMultiple = options.rewardMultiple ?? 1.8;
    this.parameterHash = sha256Hex(
      JSON.stringify({
        strategyId: this.strategyId,
        version: this.version,
        timeframe: this.timeframe,
        lookbackBars: this.lookbackBars,
        entryZScore: this.entryZScore,
        atrStopMultiplier: this.atrStopMultiplier,
        rewardMultiple: this.rewardMultiple
      })
    );
    this.lookbacks = {
      [this.timeframe]: this.lookbackBars + 2
    };
    this.lookbackRequirements = this.lookbacks;
  }

  public evaluate(snapshot: FeatureSnapshot): ProposalMenu {
    const bars = snapshot.barsByTimeframe[this.timeframe] ?? [];
    if (bars.length < this.lookbackBars + 1) {
      return {
        instrumentId: snapshot.instrumentId,
        asOfMs: snapshot.asOfMs,
        strategyId: this.strategyId,
        strategyVersion: this.version,
        proposals: [],
        standDownReason: `insufficient_lookback_${this.timeframe}`
      };
    }

    const window = bars.slice(-this.lookbackBars);
    const closes = window.map((b) => Number(b.close));
    const mean = closes.reduce((acc, v) => acc + v, 0) / closes.length;
    const variance = closes.reduce((acc, v) => acc + (v - mean) ** 2, 0) / closes.length;
    const stdDev = Math.max(1, Math.sqrt(variance));
    const latest = bars[bars.length - 1];
    if (!latest) {
      return {
        instrumentId: snapshot.instrumentId,
        asOfMs: snapshot.asOfMs,
        strategyId: this.strategyId,
        strategyVersion: this.version,
        proposals: [],
        standDownReason: `insufficient_lookback_${this.timeframe}`
      };
    }
    const closeNum = Number(latest.close);
    const zScore = (closeNum - mean) / stdDev;
    const atr = computeAtr(bars, this.lookbackBars);
    const stopDistancePoints = Math.max(1, atr * this.atrStopMultiplier);

    const proposals: Proposal[] = [];
    if (zScore <= -this.entryZScore) {
      const convictionScore = Number(
        Math.min(0.92, 0.5 + Math.min(0.35, (Math.abs(zScore) - this.entryZScore) * 0.12)).toFixed(
          4
        )
      );
      const levels = buildProtectiveLevels({
        side: "long",
        entryPriceStr: latest.close,
        stopDistancePoints,
        rewardMultiple: this.rewardMultiple
      });
      proposals.push({
        proposalId: sha256Hex(
          `${this.strategyId}:${snapshot.instrumentId}:${snapshot.asOfMs}:long`
        ).slice(0, 16),
        strategyId: this.strategyId,
        strategyVersion: this.version,
        instrumentId: snapshot.instrumentId,
        side: "long",
        entryPrice: latest.close,
        protectiveStopPrice: levels.protectiveStopPrice,
        takeProfitPrice: levels.takeProfitPrice,
        convictionScore,
        rationale: `Vol-normalized mean reversion long (zScore=${zScore.toFixed(2)} <= -${this.entryZScore.toFixed(2)})`,
        tags: ["mean-reversion", this.timeframe]
      });
    } else if (zScore >= this.entryZScore) {
      const convictionScore = Number(
        Math.min(0.92, 0.5 + Math.min(0.35, (zScore - this.entryZScore) * 0.12)).toFixed(4)
      );
      const levels = buildProtectiveLevels({
        side: "short",
        entryPriceStr: latest.close,
        stopDistancePoints,
        rewardMultiple: this.rewardMultiple
      });
      proposals.push({
        proposalId: sha256Hex(
          `${this.strategyId}:${snapshot.instrumentId}:${snapshot.asOfMs}:short`
        ).slice(0, 16),
        strategyId: this.strategyId,
        strategyVersion: this.version,
        instrumentId: snapshot.instrumentId,
        side: "short",
        entryPrice: latest.close,
        protectiveStopPrice: levels.protectiveStopPrice,
        takeProfitPrice: levels.takeProfitPrice,
        convictionScore,
        rationale: `Vol-normalized mean reversion short (zScore=${zScore.toFixed(2)} >= ${this.entryZScore.toFixed(2)})`,
        tags: ["mean-reversion", this.timeframe]
      });
    }

    return {
      instrumentId: snapshot.instrumentId,
      asOfMs: snapshot.asOfMs,
      strategyId: this.strategyId,
      strategyVersion: this.version,
      proposals,
      ...(proposals.length === 0 ? { standDownReason: "within_zscore_band" } : {})
    };
  }
}

export interface VolNormalizedMomentumOptions {
  readonly timeframe?: BarTimeframe | undefined;
  readonly lookbackBars?: number | undefined;
  readonly momentumThresholdAtr?: number | undefined;
  readonly atrStopMultiplier?: number | undefined;
  readonly rewardMultiple?: number | undefined;
}

export class VolNormalizedMomentumStrategy implements Strategy {
  public readonly id = "vol-momentum-v1";
  public readonly strategyId = "vol-momentum-v1";
  public readonly version = "1.0.0";
  public readonly name = "Vol-Normalized Momentum Impulse v1";
  public readonly description = "ATR-scaled directional impulse continuation strategy.";
  public readonly parameterHash: string;
  public readonly lookbacks: LookbackRequirement;
  public readonly lookbackRequirements: LookbackRequirement;
  private readonly timeframe: BarTimeframe;
  private readonly lookbackBars: number;
  private readonly momentumThresholdAtr: number;
  private readonly atrStopMultiplier: number;
  private readonly rewardMultiple: number;

  public constructor(options: VolNormalizedMomentumOptions = {}) {
    this.timeframe = options.timeframe ?? "1H";
    this.lookbackBars = options.lookbackBars ?? 20;
    this.momentumThresholdAtr = options.momentumThresholdAtr ?? 0.9;
    this.atrStopMultiplier = options.atrStopMultiplier ?? 2.0;
    this.rewardMultiple = options.rewardMultiple ?? 2.2;
    this.parameterHash = sha256Hex(
      JSON.stringify({
        strategyId: this.strategyId,
        version: this.version,
        timeframe: this.timeframe,
        lookbackBars: this.lookbackBars,
        momentumThresholdAtr: this.momentumThresholdAtr,
        atrStopMultiplier: this.atrStopMultiplier,
        rewardMultiple: this.rewardMultiple
      })
    );
    this.lookbacks = {
      [this.timeframe]: this.lookbackBars + 2
    };
    this.lookbackRequirements = this.lookbacks;
  }

  public evaluate(snapshot: FeatureSnapshot): ProposalMenu {
    const bars = snapshot.barsByTimeframe[this.timeframe] ?? [];
    if (bars.length < this.lookbackBars + 1) {
      return {
        instrumentId: snapshot.instrumentId,
        asOfMs: snapshot.asOfMs,
        strategyId: this.strategyId,
        strategyVersion: this.version,
        proposals: [],
        standDownReason: `insufficient_lookback_${this.timeframe}`
      };
    }

    const latest = bars[bars.length - 1];
    const anchor = bars[bars.length - 1 - this.lookbackBars];
    if (!latest || !anchor) {
      return {
        instrumentId: snapshot.instrumentId,
        asOfMs: snapshot.asOfMs,
        strategyId: this.strategyId,
        strategyVersion: this.version,
        proposals: [],
        standDownReason: `insufficient_lookback_${this.timeframe}`
      };
    }
    const latestClose = Number(latest.close);
    const anchorClose = Number(anchor.close);
    const atr = computeAtr(bars, this.lookbackBars);
    const normMomentum =
      (latestClose - anchorClose) / Math.max(1, atr * Math.sqrt(this.lookbackBars));
    const stopDistancePoints = Math.max(1, atr * this.atrStopMultiplier);

    const proposals: Proposal[] = [];
    if (normMomentum >= this.momentumThresholdAtr) {
      const convictionScore = Number(
        Math.min(
          0.94,
          0.52 + Math.min(0.35, (normMomentum - this.momentumThresholdAtr) * 0.15)
        ).toFixed(4)
      );
      const levels = buildProtectiveLevels({
        side: "long",
        entryPriceStr: latest.close,
        stopDistancePoints,
        rewardMultiple: this.rewardMultiple
      });
      proposals.push({
        proposalId: sha256Hex(
          `${this.strategyId}:${snapshot.instrumentId}:${snapshot.asOfMs}:long`
        ).slice(0, 16),
        strategyId: this.strategyId,
        strategyVersion: this.version,
        instrumentId: snapshot.instrumentId,
        side: "long",
        entryPrice: latest.close,
        protectiveStopPrice: levels.protectiveStopPrice,
        takeProfitPrice: levels.takeProfitPrice,
        convictionScore,
        rationale: `Vol-normalized momentum impulse long (normMom=${normMomentum.toFixed(2)} >= ${this.momentumThresholdAtr.toFixed(2)})`,
        tags: ["momentum", this.timeframe]
      });
    } else if (normMomentum <= -this.momentumThresholdAtr) {
      const convictionScore = Number(
        Math.min(
          0.94,
          0.52 + Math.min(0.35, (Math.abs(normMomentum) - this.momentumThresholdAtr) * 0.15)
        ).toFixed(4)
      );
      const levels = buildProtectiveLevels({
        side: "short",
        entryPriceStr: latest.close,
        stopDistancePoints,
        rewardMultiple: this.rewardMultiple
      });
      proposals.push({
        proposalId: sha256Hex(
          `${this.strategyId}:${snapshot.instrumentId}:${snapshot.asOfMs}:short`
        ).slice(0, 16),
        strategyId: this.strategyId,
        strategyVersion: this.version,
        instrumentId: snapshot.instrumentId,
        side: "short",
        entryPrice: latest.close,
        protectiveStopPrice: levels.protectiveStopPrice,
        takeProfitPrice: levels.takeProfitPrice,
        convictionScore,
        rationale: `Vol-normalized momentum impulse short (normMom=${normMomentum.toFixed(2)} <= -${this.momentumThresholdAtr.toFixed(2)})`,
        tags: ["momentum", this.timeframe]
      });
    }

    return {
      instrumentId: snapshot.instrumentId,
      asOfMs: snapshot.asOfMs,
      strategyId: this.strategyId,
      strategyVersion: this.version,
      proposals,
      ...(proposals.length === 0 ? { standDownReason: "sub_threshold_momentum" } : {})
    };
  }
}

export class BaselineChooser {
  public choose(menus: readonly ProposalMenu[]): Proposal | null {
    const candidates: Proposal[] = [];
    for (const menu of menus) {
      for (const proposal of menu.proposals) {
        candidates.push(proposal);
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort((a, b) => {
      if (b.convictionScore !== a.convictionScore) {
        return b.convictionScore - a.convictionScore;
      }
      return a.proposalId.localeCompare(b.proposalId);
    });
    return candidates[0] ?? null;
  }
}

export const DEFAULT_STRATEGIES: readonly Strategy[] = [
  new DonchianTrendStrategy(),
  new VolNormalizedMeanReversionStrategy(),
  new VolNormalizedMomentumStrategy()
];

export function resolveStrategyById(strategyId: string): Strategy {
  const found = DEFAULT_STRATEGIES.find((s) => s.strategyId === strategyId);
  if (!found) {
    throw new Error(`Unknown strategyId: ${strategyId}`);
  }
  return found;
}
