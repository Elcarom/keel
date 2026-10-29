# Keel — Domain Glossary

**Keel** (`@keel/*`) is a self-hosted systematic crypto-derivatives research lab and execution platform with measurable AI decision support.

## Core Domain & Execution Modes

**Venue**:
An external marketplace where instruments are listed and traded (for example, OKX EEA).
_Avoid_: Exchange, broker, market

**Instrument**:
A linear, quote-settled (`USDT`/`USDC`) perpetual swap contract on a Venue (for example, `BTC-USDT-SWAP`), characterized by its contract value (`ctVal`), tick size, lot size, and settlement currency.
_Avoid_: Coin, ticker, pair, asset, symbol

**One-Way Position Mode**:
Position accounting where an Instrument has at most one net position (long, short, or flat) per strategy/sub-account, rather than simultaneous long and short legs.
_Avoid_: Hedge mode, dual-side mode

**Confirmed Bar**:
An OHLCV candle whose time interval has completely elapsed and whose values are immutable.
_Avoid_: Closed candle, finished bar, historical candle

**Forming Bar**:
The currently open, in-progress candle whose high, low, close, and volume are still changing. Never used for signal generation.
_Avoid_: Live candle, incomplete bar, current candle

**As-Of Timestamp**:
The exact point in time when a piece of market data or external context (candle close, funding rate, news item) became publicly observable, gating its visibility in replay.
_Avoid_: Event time, created_at, published_at

**Data Snapshot**:
An immutable, content-hashed identifier (`DataSnapshotId`) representing the exact set of Confirmed Bars, Settled Funding records, and context features used in a Replay run so results can be reproduced bit-for-bit.
_Avoid_: Dataset version, history dump

**Lookback Requirement**:
The minimum number of contiguous Confirmed Bars per timeframe declared by a Strategy and verified at startup before the Strategy is allowed to emit Proposals.
_Avoid_: Warmup window, history length

**Settled Funding**:
The actual periodic funding payment exchanged between long and short perpetual holders at a Venue's settlement timestamp (e.g., 00:00, 08:00, 16:00 UTC), distinct from the intra-period predicted funding rate.
_Avoid_: Funding fee, current funding

**Trading Book**:
The isolated set of positions, orders, and ledger accounts belonging to one kind of execution: the **Paper Book** (simulated fills), the **Venue Book** (real fills on a Venue's Demo or real-money account), or a **Boat Book** (the simulated fills of one Boat, funded by its stake). Books never share positions or equity; only the Kill Switch state spans them all.
_Avoid_: Account, portfolio (when meaning one book)

**Venue Capital Rebase**:
An operator action, taken with step-up authentication while the Venue Book holds no open positions, that sets the Venue Book's equity to the balance the Venue actually reports and starts a new equity baseline (High-Water Mark, day start, week start). Until the Venue Book's equity is within tolerance of the Venue balance, new exchange entries are refused.
_Avoid_: Deposit, top-up, reset

**Execution Mode**:
The operating environment binding a strategy and risk engine to a market data source and a Broker adapter: **Replay** (historical event-driven simulation), **Paper** (live market data with simulated fills via `SimBroker`), **Demo** (live market data with orders routed to a Venue's sandbox/demo environment), or **Live** (real capital on a Venue).
_Avoid_: Dry run, backtest mode, sim mode

## Strategy, AI & Risk

**Strategy**:
A pure, deterministic function mapping a point-in-time feature snapshot of Confirmed Bars and context features to a menu of candidate trade **Proposals**.
_Avoid_: Bee, agent, brain (a **Boat** is a funded, running instance of a Strategy, not the Strategy itself)

**Proposal**:
A candidate trade intent (open, add, reduce, close, or hold) emitted by a Strategy, annotated with target sizing parameters and initial stop placement before Risk Engine evaluation.
_Avoid_: Signal, move, order, idea

**Baseline Chooser**:
The deterministic rule that selects a Proposal from a Strategy's menu without AI involvement, serving as both the fallback and the control benchmark for measuring AI value-add.
_Avoid_: Fallback chooser, code chooser, default picker

**Shadow Advisor**:
An AI capability that evaluates a Strategy's menu in parallel with the Baseline Chooser, recording its pick and reasoning for A/B scoring without routing orders until promoted.
_Avoid_: Jev, AI trader, LLM picker

**LLM Gateway**:
The provider-agnostic boundary governing all AI calls, enforcing schema validation, pre-call budget reservation, prompt/response audit logging, deterministic replay recording, and model training-cutoff metadata (currently backed by the Gemini adapter).
_Avoid_: AI client, model wrapper, OpenAI helper

**Context Feature**:
A structured, closed-enum data record (event type, affected Instruments, directional bias, novelty, confidence, and provenance) extracted from untrusted external text (announcements, RSS news, macro calendar) and stamped with an `As-Of Timestamp` (`max(publishedAt, ingestedAt)`).
_Avoid_: News signal, sentiment score, raw article

**Training Contamination**:
The statistical bias introduced when an LLM with a training cutoff after a historical timestamp evaluates data from that period. Any replay using an unrecorded LLM call on pre-cutoff dates is flagged as contaminated.
_Avoid_: Look-ahead bias (reserve Look-Ahead Bias for future data leakage in code/features), data leakage

**Promotion Ladder**:
The quantitative, gated progression a Strategy or AI capability must pass to earn capital authority: **Idea → Replay-Validated → Forward Shadow → Paper Capital → Live-Ramp → Live**.
_Avoid_: Lifecycle, pipeline, stage

**Experiment Registry**:
The append-only ledger of every backtest, walk-forward run, parameter sweep, and AI strategy candidate ever evaluated, used to track cumulative trial count (`N`) and compute the Deflated Sharpe Ratio and Probability of Backtest Overfitting.
_Avoid_: Backtest history, run log

**Config Risk Class**:
The safety classification assigned to every setting in the schema registry governing how it can be modified in the UI: `safe` (immediate apply), `confirm` (requires typed confirmation and password/TOTP step-up), `restart-required` (staged until container restart), or `locked-in-live` (cannot be edited while Execution Mode is `Live-Ramp` or `Live`).
_Avoid_: Setting permission, knob level

**Risk Engine**:
The deterministic, pure module on the money path that validates, sizes, shrinks, or vetoes a chosen Proposal and emits forced exits (stops, loss caps, staleness flattens, kill switch).
_Avoid_: Risk manager, guard, filter

**Protective Stop**:
An exchange-resident conditional or algorithmic stop-loss order attached to every open position so protection survives engine crashes or network partitions.
_Avoid_: Hard stop, exchange stop, SL order

**Dead-Man's Switch (DMS)**:
An exchange-enforced countdown timer (`cancel-all-after`) refreshed by periodic engine heartbeats that automatically cancels all resting entry/add orders if the engine disconnects or crashes, while leaving attached Protective Stops intact on open positions.
_Avoid_: Heartbeat cancel, disconnect timer

**Unit Risk (1R)**:
The maximum quote-currency loss budgeted for a single trade if its initial Protective Stop is hit, defined as a percentage of strategy equity (default `0.75%`) and used to compute integer contract size.
_Avoid_: Bet size, notional fraction, risk unit

**Net Directional Exposure**:
The signed sum of long minus short notional across all open positions in the portfolio divided by total portfolio equity, used to cap correlated crypto beta (default `±1.25x`).
_Avoid_: Net leverage, delta, portfolio beta

**High-Water Mark (HWM)**:
The highest peak equity reached by a Strategy or the Portfolio over its active lifecycle, used as the reference point for drawdown stops and automatic demotion.
_Avoid_: Peak balance, max equity

**Kill Switch**:
An immediate, deterministic emergency command (triggered manually from Mission Control or automatically by a portfolio breach) that cancels all non-protective open orders, flattens all open positions in both Trading Books at market, and locks the system against new entries until an operator resets it with step-up authentication.
_Avoid_: Panic button, emergency stop, halt

**Kill Switch Flatten**:
The verified execution of a Kill Switch event: locking out new entries first, then cancelling non-protective resting orders, market-closing 100% of every open position in both Trading Books, and confirming against the Venue that each book is flat. A position's Protective Stop is withdrawn only after its close is confirmed, so a failed close is never left unprotected.
_Avoid_: Soft flatten, local close

**Sealed Holdout Period**:
An out-of-sample partition of historical market data (specifically 2025-01-01 to 2025-12-31 UTC) that was strictly quarantined and evaluated once in Phase D verification. Now spent.
_Avoid_: Test set, validation split

**Unspent Sealed Holdout Partition (2026)**:
The forward out-of-sample partition of market data (specifically 2026-01-01 00:00:00 UTC to 2026-06-30 23:59:59 UTC) that is strictly quarantined and unspent, reserved for future single-shot out-of-sample evaluation of newly formulated alpha hypotheses.
_Avoid_: Spent holdout, unquarantined data

**In-Sample Period**:
The historical market data window (2023-01-01 to 2024-12-31 UTC) allocated for feature computation, model fitting, and purged walk-forward cross-validation under 2x cost stress.
_Avoid_: Train set, backtest range

**Next-Bar Open Execution**:
The causal execution model where a trade Proposal generated upon the confirmation of bar `t` executes strictly at the opening price of bar `t+1` (adjusted for slippage), preventing intra-bar look-ahead.
_Avoid_: Close fill, instantaneous execution

**Gap-Aware Stop Fill**:
Simulated protective stop execution that accounts for price jumps between bars: filling long stops at `min(open, stopPrice)` and short stops at `max(open, stopPrice)` rather than assuming execution at the exact stop level.
_Avoid_: Perfect fill, idealized stop

**Trial Universe**:
The explicit count of candidate models, parameter variations, and heuristic specifications evaluated within a defined research campaign, used directly as `numTrials` in Deflated Sharpe Ratio calculation to penalize multi-testing and prevent selection bias.
_Avoid_: Database row count, experiment table size

**Baseline Outperformance Gate**:
The mandatory Replay promotion condition requiring a candidate strategy's annualized Sharpe ratio to strictly exceed both the Buy & Hold baseline and the Random Entry baseline under identical cost stress.
_Avoid_: Unbenchmarked Sharpe, absolute Sharpe hurdle

**Per-Bar Idempotency**:
The property of the execution engine and scheduler ensuring that a confirmed bar `(instrumentId, strategyId, closeTs)` is processed at most once, preventing duplicate position sizing, false exits against pre-entry bars, or corrupted ledger metrics.
_Avoid_: Free-running tick, repeated bar processing

## The Fleet

**Fleet**:
Every Boat the operator has launched, with the Wallets that fund them.
_Avoid_: Portfolio, swarm, hive

**Boat**:
A running instance of one Strategy compiled from a Blueprint, with a name, a stake drawn from a Wallet, and its own Boat Book. A Boat is running (at sea), paused (in harbour, flat and not trading) or retired (flat for good, its equity returned to the Wallet).
_Avoid_: Bot (in operator-facing text), Strategy, agent, bee

**Wallet**:
A pool of cash that stakes Boats. A Boat's stake leaves the Wallet when it launches and its equity returns when it retires. Paper Wallets hold simulated cash only.
_Avoid_: Account, sub-account, balance

**Stake**:
The cash a Boat is launched with, drawn from its Wallet; the Boat's starting equity.
_Avoid_: Allocation (in operator-facing text), budget

**Blueprint**:
A bounded description of a Boat's trading idea: one of a fixed set of archetypes plus clamped parameters, compiled deterministically into a Strategy Spec.
_Avoid_: Prompt, config, recipe

**Invention**:
Entry rules Claude wrote itself in the Strategy Spec condition language, instead of tuning one of the reviewed archetypes. Keel checks every Invention against the language's limits, attaches the protective stop and take-profit itself, and renders the rules in plain English. A Blueprint holds at most one Invention.
_Avoid_: Custom strategy, AI strategy (the AI never trades it; the compiled rules do)

**Inventor Mode**:
The Shipyard mode in which Claude writes Inventions rather than filling Blueprints.
_Avoid_: Free mode, creative mode

**Imported Invention**:
An Invention the operator brings in as a file, written by Claude in the operator's own chat rather than through Keel's API key. It keeps its own market and direction, and faces exactly the checks and Sea Trial any other Invention faces.
_Avoid_: Uploaded strategy, manual strategy

**Proposition**:
A Blueprint offered as a candidate Boat, with its Sea Trial Assessment and rank within its design batch. Not to be confused with a **Proposal**, which is a single trade intent.
_Avoid_: Proposal, idea, candidate strategy

**Shipyard**:
Where the operator writes a guided brief, the Boat designer drafts Propositions, and every Proposition goes through a Sea Trial and is ranked before it can be launched.
_Avoid_: Strategy Lab (the older research surface), generator

**Sea Trial**:
The examination every Proposition faces before it is ranked: its backtest, the same idea with each setting nudged, and the same idea on its Sibling Market, judged by a list of named checks. Some checks are critical; a Proposition failing any critical check is never rated seaworthy, whatever its score.
_Avoid_: Backtest (a Sea Trial contains several), audition

**Verdict**:
A Sea Trial's one-word conclusion: seaworthy, promising, choppy or sinks.
_Avoid_: Grade, rating

**Sibling Market**:
The instrument a Proposition's idea is re-tested on during its Sea Trial, chosen because it trades much like the original. An edge that only exists on one market is more likely luck.
_Avoid_: Control market, benchmark

**Paper-only Instrument**:
An instrument Boats may trade on paper but the exchange broker refuses. Making one tradable on an exchange is a Gate G2 decision.
_Avoid_: Unsupported instrument
