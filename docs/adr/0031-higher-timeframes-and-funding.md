# ADR-0031: Higher-Timeframe Bars and Funding in the Rule Language

## Status

Accepted. This extends ADR-0020.

## Context and Decision

Many ideas mix horizons, such as trading the hour in the direction of the day. Others lean on crowding, which shows up in funding.

- **Higher timeframes are built, not fetched.** A `timeframe` of `"4H"` or `"1D"` on a number reading or an indicator rolls the confirmed 1H bars up into UTC-aligned 4-hour or daily bars. Only a complete bucket counts, so a higher-timeframe bar exists only once its last hour has closed, and no forming bar can leak in. A shift counts bars of that timeframe. When no complete bar exists yet, a reading is NaN, so every comparison with it is false.
- **The 500-bar lookback still holds.** A higher-timeframe window or shift may span at most 480 hours: 120 four-hour bars or 20 daily bars. The lookback and warm-up count in hours.
- **Funding is a bar field.** `funding` reads the traded coin's latest settled 8-hour rate as of the bar, in basis points.

## Consequences

- OKX's public funding history reaches back only a few months. Across most of the two-year sea-trial window `funding` reads 0, so a strategy built only on funding rarely trades in its trial. The prompts tell Claude this, and the trial's funding label says when funding was assumed.
- No new data is ingested: higher-timeframe bars come from the hourly bars Keel already holds.
