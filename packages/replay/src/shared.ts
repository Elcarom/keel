import {
  ALL_BAR_TIMEFRAMES,
  type BarTimeframe,
  type ConfirmedBar,
  type FeatureSnapshot,
  type MarketDataRepository,
  type SettledFundingRate
} from "@keel/core";
import type { Strategy } from "@keel/strategy";

// Pieces the single-market replay and the pair replay share.

export function updateTrackedDrawdown(params: {
  readonly peakEquityNum: number;
  readonly closeEquityNum: number;
  readonly worstIntraEquityNum: number;
  readonly currentMaxDrawdownPct: number;
}): {
  readonly newPeakEquityNum: number;
  readonly newMaxDrawdownPct: number;
} {
  let peak = params.peakEquityNum;
  if (params.closeEquityNum > peak) {
    peak = params.closeEquityNum;
  }
  let maxDd = params.currentMaxDrawdownPct;
  if (peak > 0) {
    const ddWorst = ((peak - params.worstIntraEquityNum) / peak) * 100;
    const ddClose = ((peak - params.closeEquityNum) / peak) * 100;
    if (ddWorst > maxDd) maxDd = ddWorst;
    if (ddClose > maxDd) maxDd = ddClose;
  }
  return { newPeakEquityNum: peak, newMaxDrawdownPct: maxDd };
}

/**
 * Builds the same causal snapshots as `MarketDataRepository.buildFeatureSnapshot` from bars already
 * in memory, so a replay reads the database once instead of once per bar. Only single-timeframe
 * strategies on the replay timeframe qualify; anything else falls back to the repository.
 */
export function createInMemorySnapshots(params: {
  readonly marketDataRepo: MarketDataRepository;
  readonly instrumentId: string;
  readonly timeframe: BarTimeframe;
  readonly requirements: Strategy["lookbacks"];
  readonly bars: readonly ConfirmedBar[];
  readonly settledFunding: readonly SettledFundingRate[];
  /** Other markets the strategy reads; each is served as of the same moment. */
  readonly referenceMarkets?: readonly string[] | undefined;
}): ((asOfMs: number) => FeatureSnapshot) | null {
  const required = ALL_BAR_TIMEFRAMES.filter((tf) => (params.requirements[tf] ?? 0) > 0);
  const count = params.requirements[params.timeframe] ?? 0;
  const firstBar = params.bars[0];
  if (!firstBar || required.length !== 1 || required[0] !== params.timeframe) return null;

  // Warm-up history: exactly what an as-of query at the window's first bar would see
  const series = [
    ...params.marketDataRepo.getConfirmedBarsAsOf({
      instrumentId: params.instrumentId,
      timeframe: params.timeframe,
      asOfMs: firstBar.openTs,
      limit: count
    }),
    ...params.bars
  ];
  const funding = [
    ...params.marketDataRepo.getSettledFundingAsOf({
      instrumentId: params.instrumentId,
      asOfMs: firstBar.openTs - 1,
      limit: 30
    }),
    ...params.settledFunding
  ];

  // Each reference market over the same window, warm-up included
  const lastBar = params.bars[params.bars.length - 1] ?? firstBar;
  const references = (params.referenceMarkets ?? []).map((market) => ({
    market,
    series: [
      ...params.marketDataRepo.getConfirmedBarsAsOf({
        instrumentId: market,
        timeframe: params.timeframe,
        asOfMs: firstBar.openTs,
        limit: count
      }),
      ...params.marketDataRepo.getConfirmedBarsInRange({
        instrumentId: market,
        timeframe: params.timeframe,
        fromOpenTs: firstBar.openTs,
        toCloseTs: lastBar.closeTs
      })
    ]
  }));

  // Index of the first element whose timestamp is after asOfMs
  const upperBound = <T>(items: readonly T[], ts: (item: T) => number, asOfMs: number): number => {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const item = items[mid];
      if (item !== undefined && ts(item) <= asOfMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return (asOfMs) => {
    const barEnd = upperBound(series, (b) => b.closeTs, asOfMs);
    const fundingEnd = upperBound(funding, (f) => f.fundingTs, asOfMs);
    return {
      instrumentId: params.instrumentId,
      asOfMs,
      barsByTimeframe: { [params.timeframe]: series.slice(Math.max(0, barEnd - count), barEnd) },
      recentFundingRates: funding.slice(Math.max(0, fundingEnd - 30), fundingEnd),
      ...(references.length > 0
        ? {
            referenceBars: Object.fromEntries(
              references.map(({ market, series: ref }) => {
                const end = upperBound(ref, (b) => b.closeTs, asOfMs);
                return [market, ref.slice(Math.max(0, end - count), end)];
              })
            )
          }
        : {})
    };
  };
}

export const FUNDING_INTERVAL_MS = 8 * 3_600_000;
