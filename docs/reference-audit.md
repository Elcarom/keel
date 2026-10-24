# beebots: institutional audit

I read the strategy, data, risk, execution, ledger, engine and config code in full. I skimmed the React dashboard, Hive/Keeper HTTP plumbing and Setup, and I did not install dependencies or run the test suite. Three claims below were checked by running the repo's own `indicators.ts` on synthetic data, and I flag them as such.

---

## 1. Executive summary & architecture

**What it is:** A TypeScript (Node 22) paper-trading game. Three "bees" start with $333 each and trade OKX EEA crypto X-Perps at up to 2x isolated leverage. The 10s tick and 60s data refresh put it at roughly minute-to-hour holding periods. `MODE=dry` is the default, and the stack ships with a public leaderboard (the Hive), AI-generated bee portraits and a Hostinger affiliate link. The project is about 10 days old (v2026.10.14).

**The LLM is not the strategy.** Gemini/Jev only picks a label from a menu that code builds (`bees/*.ts → menu()`). Code then vetoes, sizes and stops (`risk.ts`). When the model is off, over budget or slow, `jev.ts:fallbackDecide` takes the highest-priority menu item. In practice the rule engine is the strategy and the LLM is a noisy tie-breaker.

**Data flow:**
1. `okx/public.ts` polls REST for tickers, open interest, funding, and 15m/1H/4H candles. There is no websocket.
2. `MarketFeed.refresh` (`market/data.ts`) gates the universe by volume, spread and an hardcoded crypto allow-list, then runs `computeStats`.
3. Each `BeeBrain.menu()` turns the stats into legal moves. `buildSnapshot` makes the prompt and `Jev.decide` picks a label (paced to at most once a minute per bee, cached, with the code fallback).
4. `applyRisk` is a pure function that applies caps, stops, time stops, the cooldown, the spread gate, funding vetoes and sizing.
5. `Engine.execute` runs under a per-bee lock, then `SimExecutor` (fills at the touch) or `OkxExecutor` (CLI subprocess) fills the order. `ledger.applyFill` updates the books and SQLite stores them.
6. A separate `exitWatch` timer (at most every 2s) re-polls tickers and fires stops independently of the LLM tick.

**Core engine:** `engine.ts` (1,005 lines) plus `risk.ts`. The alpha lives in `bees/bizzy.ts`, `boozy.ts` and `breezy.ts`.

---

## 2. Quantitative audit

**Backtest integrity: there is no backtest.** I grepped the repo and found no historical replay harness. The only validation is forward paper trading on about 10 days of data, with three bees on one correlated asset class. A leaderboard of % gains from that sample is a ranking of noise.

Parameters were also tuned against that same live paper sample. The code comments cite specific incidents ("fatal 24h lockup", a 27 Sep margin rejection), and the Beekeeper has an LLM rewrite a bee's rules after it loses. Both are in-sample fitting with no holdout and no multiple-testing correction.

**Breezy (Donchian ensemble) doesn't implement the strategy it cites.** `strategies/BREEZY_BEE.md` quotes Sharpe ~1.56 from Zarattini et al., but that paper's rules are:
- daily bars
- long-only
- 25% vol target
- 5 to 360 day lookbacks

Breezy uses 4H bars with shorts, a 40% vol cap and the same lookback numbers as bar counts. That compresses the time scale about 6x (20 hours to 60 days). The published results don't transfer.

I also found two concrete bugs, verified by running `donchianEnsemble` on a synthetic random walk:
- **The 360 slice can never turn on.** The feed fetches 300 4H bars (`data.ts`, `candles(id, "4H", 300)`), and a slice needs `L+1` bars. Result: `slicesAvailable = 8`, so the score maxes at ±8. Sizing still divides by 9 (`breezySizeFrac`) and the docs say −9..+9.
- **The 250 slice replays only about 50 bars** of state. Window-start sensitivity itself turned out to be small (a 6-bar shift changed the score on 3% of bars, never by more than 1 point). The missing slice matters more.

**Repainting: every signal uses the forming candle.** `confirmed` is read in exactly one place (`data.ts:36-38`, for volume z-score). RSI, Bollinger, ATR, MACD and Donchian all include the in-progress bar. A "close above the channel" can fire mid-bar and vanish by the close.

**Market realism is thin:**
- `SimExecutor` fills at the last polled bid/ask with a flat 5bp taker fee. It models no latency, queue, depth or impact.
- Funding is charged at the *current* rate when a 00/08/16 UTC slot is crossed, and slots missed during downtime are never charged (`lastFundingSlot` resets on restart). Both are simplifications of the real settled funding.
- Bizzy's round trip costs about 15bp (2×5bp fee plus the 5bp spread gate), which is ~$0.48 on its ~$323 notional (computed). Its exit target is the 15m Bollinger mid-band. Check that gross target against your own fills; there is no evidence that net expectancy is positive.
- Boozy's "impulse" test (`impulseSide`: 24h return ≥ 1.5%, 1h ≥ 0, RSI ≤ 78) uses fixed thresholds, not vol-normalised ones. On volatile alts that is a fraction of one daily sigma, so it probably qualifies a large share of coins. The real filter becomes the LLM, which is unmeasured. Verify this against the decision logs.

**Signal quality:** Bizzy is a textbook RSI<30 & %B<0 fade on 15m bars. Boozy chases 24h momentum with a 30-minute minimum hold and a 12h time stop. Both are retail tropes with hand-set thresholds. Breezy's Donchian ensemble is the only one with real literature behind it, and it is the one that was altered and bugged.

**The LLM's contribution is unmeasurable.** Nothing logs what the code chooser would have picked next to what the model picked, so you can't A/B it. Model versions and pricing change, so runs aren't reproducible either.

**Risk management:**
- *Good:* the pure `applyRisk`, an 8% daily loss stop, retirement at 40% of equity, trade and fee caps, ratcheting stops with profit-lock rungs, and notional capped at `min(2×equity×0.97, $700)`.
- *Bad (software-only stops):* `OkxExecutor` only places market orders. There are no exchange-resident stop or algo orders. A process crash, network partition or REST outage leaves a naked 2x position.
- *Bad (blind stops):* `tick()` catches a failed `refreshTickers`, logs a warning and carries on, so `markBee` re-marks the old prices. The staleness check in `risk.ts` step 5 applies only to opening orders, and it keys off the 60s full refresh, not ticker age. A ticker outage silently disables stop evaluation.
- *Missing:* any cross-bee exposure check. Three bees can all be long crypto beta at 2x, which is a single factor.
- Stops trigger on the mid, but exits execute on the bid or ask.

The Hive's "verified" badge replays a bee's own submitted fills against public candles. That checks internal consistency, not skill.

---

## 3. Software engineering audit

**What's well done**, since it affects the verdict:
- `risk.ts` is a pure function with an injected clock.
- `Executor` is a clean sim/OKX seam.
- A per-bee order lock plus `exitEpoch` drops stale decisions after a stop fires.
- `clOrdId` gives idempotency, and a 5-minute reconciliation adopts OKX's position as truth.
- LLM spend is reserved in the DB before the call.
- Config is validated with zod, and there are about 390 tests in 24 files (53 on risk alone).

**Weaknesses:**
- **`engine.ts` is a god class.** It handles decisions, execution, funding, reconciliation, wind-down and dashboard views. `BeeBrain` mixes signal, sizing, stops and LLM prompt text behind 20+ optional hooks. Because market data can't be injected from history, none of it can run offline.
- **Live execution spawns an `okx` CLI subprocess per call** (`okx/cli.ts`). That adds latency and a fragile failure mode to the path that fires stops. The fill poll is up to 12 retries with sleeps.
- **Polling-only architecture.** There are 10s REST ticks, a 900ms cache TTL, and no private or public websocket. Each refresh refetches 100/200/300 bars per coin for the whole gated universe instead of appending. `donchianEnsemble` is O(slices × bars × L) with `Math.max(...window)`; it only runs on BTC and ETH, but a monotonic deque would be O(n).
- **Single process with no dead-man's switch.** There's no heartbeat to the exchange and no cancel-on-disconnect equivalent.
- **Knob sprawl.** There are 60+ env settings. The README admits an old `.env` silently overrides new defaults, and a whole `effective-config` tool exists to detect that drift.
- **Security surface (per the README):** a public dashboard, Setup open to the first visitor for 2 hours, and API keys stored in `/data/settings.json`.

---

## 4. Verdict & roadmap

| | Score | Notes |
|---|---|---|
| **Quant Rigor** | **2/10** | No backtest, no statistics, hand-tuned on the live sample, one strategy mis-implemented. |
| **Engineering Quality** | **7/10** | Disciplined for its class; weak spots are polling, CLI execution and no exchange-side stops. |

This is a well-built entertainment and paper-trading harness. It isn't a research framework, and it isn't production-ready for real money.

### Critical fixes
1. **Make stops fail-safe.** Attach exchange-side conditional or algo stops to every entry. Add a ticker-age guard based on the ticker's `ts` that flattens or alarms when data goes stale. Add a watchdog that closes positions if the engine dies.
2. **Build an offline event-driven replay.** Feed historical candles, funding and spread into the existing pure `menu()` and `applyRisk()`. Run the code chooser, which is deterministic and is the real strategy, over 2+ years with fees, spread and settled funding, using walk-forward splits. Report net Sharpe, turnover and a deflated Sharpe. Make no performance claims until this exists.
3. **Fix Breezy and the repainting.** Fetch 361+ bars (or use daily bars as the paper does, paginating history-candles). Drop the forming candle from every indicator. Make the score denominator equal `slicesAvailable`.

### Next-level upgrades
- Log the code chooser's pick beside the LLM's on every decision, so the model's marginal value can be measured. Disable the Beekeeper until its rewrites are validated out-of-sample with a multiple-testing penalty.
- Vol-normalise all entry thresholds, and size by fixed risk per trade rather than a fraction of notional.
- Add a portfolio layer with net exposure and beta caps across bees.
- Improve the cost model with L2 depth, latency and partial fills. Replace the CLI subprocess with signed REST plus a private websocket.
- Add a persistent incremental candle store (SQLite or Parquet) instead of refetching.
- Split `engine.ts` into decision, execution, accounting and reconciliation services.
- Stamp each decision with a strategy-version hash, and report per-bee trade counts, confidence intervals and t-stats on the dashboard.