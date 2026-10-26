import type { DatabaseSync } from "node:sqlite";
import {
  CircuitBreakerRecordSchema,
  LedgerAccountSchema,
  LedgerEntryRecordSchema,
  LedgerTrialBalanceSchema,
  PaperOrderRecordSchema,
  PaperPositionRecordSchema,
  PromotionStageSchema,
  ProposalSchema,
  ScaledDecimal,
  StrategyPromotionRecordSchema,
  getUtcDayStartMs,
  getUtcWeekStartMs,
  type CircuitBreakerRecord,
  type LedgerEntryRecord,
  type LedgerRepository,
  type LedgerRiskMetrics,
  type LedgerTrialBalance,
  type NewLedgerJournalInput,
  type PaperAccountRepository,
  type PaperOrderRecord,
  type PaperPositionRecord,
  type PromotionRepository,
  type Proposal,
  type StrategyPromotionRecord
} from "@keel/core";

export const PAPER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id TEXT PRIMARY KEY,
  tx_group_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  strategy_id TEXT,
  instrument_id TEXT,
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  amount_usdt TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_ts ON ledger_entries(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx_group ON ledger_entries(tx_group_id);

CREATE TABLE IF NOT EXISTS paper_positions (
  position_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL,
  contracts TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  protective_stop_price TEXT NOT NULL,
  take_profit_price TEXT,
  initial_risk_usdt TEXT NOT NULL,
  unrealized_pnl_usdt TEXT NOT NULL,
  realized_pnl_usdt TEXT NOT NULL,
  fees_paid_usdt TEXT NOT NULL,
  funding_paid_usdt TEXT NOT NULL,
  opened_at_ms INTEGER NOT NULL,
  last_funding_settled_ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  closed_at_ms INTEGER,
  exit_price TEXT,
  exit_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_status ON paper_positions(status);

CREATE TABLE IF NOT EXISTS paper_orders (
  order_id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL,
  order_role TEXT NOT NULL,
  contracts TEXT NOT NULL,
  fill_price TEXT NOT NULL,
  protective_stop_price TEXT NOT NULL,
  fee_usdt TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_created ON paper_orders(created_at_ms DESC);

CREATE TABLE IF NOT EXISTS circuit_breaker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  triggered_at_ms INTEGER NOT NULL,
  cooldown_until_ms INTEGER,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_promotions (
  strategy_id TEXT PRIMARY KEY,
  current_stage TEXT NOT NULL,
  latest_experiment_id TEXT,
  replay_gate_passed INTEGER NOT NULL,
  paper_trades_count INTEGER NOT NULL,
  paper_drawdown_pct REAL NOT NULL,
  eligible_next_stage TEXT,
  demotion_reason TEXT,
  promoted_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_processed_bars (
  instrument_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  close_ts INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS paper_pending_proposals (
  strategy_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  PRIMARY KEY (strategy_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS ledger_equity_snapshots (
  strategy_id TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  equity_usdt TEXT NOT NULL,
  PRIMARY KEY (strategy_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_ledger_equity_snapshots ON ledger_equity_snapshots(strategy_id, ts ASC);
`;

function mapLedgerRow(row: Record<string, unknown>): LedgerEntryRecord {
  return LedgerEntryRecordSchema.parse({
    entryId: String(row["entry_id"]),
    txGroupId: String(row["tx_group_id"]),
    ts: Number(row["ts"]),
    strategyId: row["strategy_id"] === null ? null : String(row["strategy_id"]),
    instrumentId: row["instrument_id"] === null ? null : String(row["instrument_id"]),
    debitAccount: LedgerAccountSchema.parse(String(row["debit_account"])),
    creditAccount: LedgerAccountSchema.parse(String(row["credit_account"])),
    amountUsdt: String(row["amount_usdt"]),
    description: String(row["description"])
  });
}

function mapPositionRow(row: Record<string, unknown>): PaperPositionRecord {
  return PaperPositionRecordSchema.parse({
    positionId: String(row["position_id"]),
    strategyId: String(row["strategy_id"]),
    instrumentId: String(row["instrument_id"]),
    side: String(row["side"]),
    contracts: String(row["contracts"]),
    entryPrice: String(row["entry_price"]),
    protectiveStopPrice: String(row["protective_stop_price"]),
    takeProfitPrice: row["take_profit_price"] === null ? null : String(row["take_profit_price"]),
    initialRiskUsdt: String(row["initial_risk_usdt"]),
    unrealizedPnlUsdt: String(row["unrealized_pnl_usdt"]),
    realizedPnlUsdt: String(row["realized_pnl_usdt"]),
    feesPaidUsdt: String(row["fees_paid_usdt"]),
    fundingPaidUsdt: String(row["funding_paid_usdt"]),
    openedAtMs: Number(row["opened_at_ms"]),
    lastFundingSettledTs: Number(row["last_funding_settled_ts"]),
    status: String(row["status"]),
    closedAtMs: row["closed_at_ms"] === null ? null : Number(row["closed_at_ms"]),
    exitPrice: row["exit_price"] === null ? null : String(row["exit_price"]),
    exitReason: row["exit_reason"] === null ? null : String(row["exit_reason"])
  });
}

function mapOrderRow(row: Record<string, unknown>): PaperOrderRecord {
  return PaperOrderRecordSchema.parse({
    orderId: String(row["order_id"]),
    positionId: String(row["position_id"]),
    proposalId: String(row["proposal_id"]),
    strategyId: String(row["strategy_id"]),
    instrumentId: String(row["instrument_id"]),
    side: String(row["side"]),
    orderRole: String(row["order_role"]),
    contracts: String(row["contracts"]),
    fillPrice: String(row["fill_price"]),
    protectiveStopPrice: String(row["protective_stop_price"]),
    feeUsdt: String(row["fee_usdt"]),
    status: String(row["status"]),
    createdAtMs: Number(row["created_at_ms"])
  });
}

export function createLedgerRepository(
  db: DatabaseSync,
  initialEquityUsdt = "10000.00000000"
): LedgerRepository {
  // Seed initial equity capital if ledger is completely empty
  const countRow = db.prepare("SELECT COUNT(*) AS cnt FROM ledger_entries").get();
  const count = Number(countRow?.["cnt"] ?? 0);
  if (count === 0) {
    db.prepare(
      `INSERT INTO ledger_entries (
        entry_id, tx_group_id, ts, strategy_id, instrument_id, debit_account, credit_account, amount_usdt, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "entry-seed-equity",
      "tx-seed-equity",
      0,
      null,
      null,
      "cash:usdt",
      "equity_capital:usdt",
      initialEquityUsdt,
      "Initial paper portfolio capital seed"
    );
  }

  return {
    recordJournal(input: NewLedgerJournalInput): LedgerEntryRecord {
      const amountDec = ScaledDecimal.fromString(input.amountUsdt);
      if (!amountDec.isPositive()) {
        throw new Error("Ledger journal amount must be strictly positive");
      }
      const seqRow = db.prepare("SELECT COUNT(*) AS cnt FROM ledger_entries").get();
      const seq = Number(seqRow?.["cnt"] ?? 0) + 1;
      const entryId = `entry-${input.txGroupId}-${input.ts}-${seq}`;
      db.prepare(
        `INSERT INTO ledger_entries (
          entry_id, tx_group_id, ts, strategy_id, instrument_id, debit_account, credit_account, amount_usdt, description
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entryId,
        input.txGroupId,
        input.ts,
        input.strategyId,
        input.instrumentId,
        input.debitAccount,
        input.creditAccount,
        amountDec.toFixed(8),
        input.description
      );

      return {
        entryId,
        txGroupId: input.txGroupId,
        ts: input.ts,
        strategyId: input.strategyId,
        instrumentId: input.instrumentId,
        debitAccount: input.debitAccount,
        creditAccount: input.creditAccount,
        amountUsdt: amountDec.toFixed(8),
        description: input.description
      };
    },

    listEntries(limit = 100): readonly LedgerEntryRecord[] {
      const rows = db
        .prepare(
          `SELECT entry_id, tx_group_id, ts, strategy_id, instrument_id, debit_account, credit_account, amount_usdt, description
           FROM ledger_entries ORDER BY ts DESC, entry_id DESC LIMIT ?`
        )
        .all(limit);
      return rows.map((r) => mapLedgerRow(r as Record<string, unknown>));
    },

    getTrialBalance(): LedgerTrialBalance {
      const rows = db
        .prepare(`SELECT debit_account, credit_account, amount_usdt FROM ledger_entries`)
        .all() as { debit_account: string; credit_account: string; amount_usdt: string }[];

      let totalDebits = ScaledDecimal.zero();
      let totalCredits = ScaledDecimal.zero();
      let cash = ScaledDecimal.zero();
      let realizedPnl = ScaledDecimal.zero();
      let feesExpense = ScaledDecimal.zero();
      let fundingPnl = ScaledDecimal.zero();

      for (const row of rows) {
        const amt = ScaledDecimal.fromString(row.amount_usdt);
        totalDebits = totalDebits.add(amt);
        totalCredits = totalCredits.add(amt);

        // Account balances (Assets: normal debit; Expenses: normal debit; Revenue/Equity: normal credit)
        if (row.debit_account === "cash:usdt") cash = cash.add(amt);
        if (row.credit_account === "cash:usdt") cash = cash.sub(amt);

        if (row.credit_account === "realized_pnl:usdt") realizedPnl = realizedPnl.add(amt);
        if (row.debit_account === "realized_pnl:usdt") realizedPnl = realizedPnl.sub(amt);

        if (row.debit_account === "fees_expense:usdt") feesExpense = feesExpense.add(amt);
        if (row.credit_account === "fees_expense:usdt") feesExpense = feesExpense.sub(amt);

        if (row.credit_account === "funding_pnl:usdt") fundingPnl = fundingPnl.add(amt);
        if (row.debit_account === "funding_pnl:usdt") fundingPnl = fundingPnl.sub(amt);
      }

      const isBalanced = totalDebits.equals(totalCredits);

      return LedgerTrialBalanceSchema.parse({
        totalDebitsUsdt: totalDebits.toFixed(8),
        totalCreditsUsdt: totalCredits.toFixed(8),
        isBalanced,
        cashBalanceUsdt: cash.toFixed(8),
        realizedPnlUsdt: realizedPnl.toFixed(8),
        feesExpenseUsdt: feesExpense.toFixed(8),
        fundingPnlUsdt: fundingPnl.toFixed(8),
        netEquityUsdt: cash.toFixed(8),
        entryCount: rows.length
      });
    },

    getRiskMetrics(params: {
      readonly asOfMs: number;
      readonly strategyId?: string | null | undefined;
      readonly openUnrealizedPnlUsdt?: ScaledDecimal | undefined;
    }): LedgerRiskMetrics {
      const { asOfMs, strategyId, openUnrealizedPnlUsdt } = params;
      const unrealized = openUnrealizedPnlUsdt ?? ScaledDecimal.zero();
      const dayStartMs = getUtcDayStartMs(asOfMs);
      const weekStartMs = getUtcWeekStartMs(asOfMs);

      let query = `SELECT ts, strategy_id, debit_account, credit_account, amount_usdt
                   FROM ledger_entries
                   WHERE ts <= ?`;
      const queryParams: unknown[] = [asOfMs];
      if (strategyId) {
        query += ` AND (strategy_id IS NULL OR strategy_id = ?)`;
        queryParams.push(strategyId);
      }
      query += ` ORDER BY ts ASC, rowid ASC`;

      const rows = db.prepare(query).all(...queryParams) as {
        ts: number;
        strategy_id: string | null;
        debit_account: string;
        credit_account: string;
        amount_usdt: string;
      }[];

      let runningCash = ScaledDecimal.zero();
      let hwm = ScaledDecimal.zero();
      let dayStartCash = ScaledDecimal.zero();
      let weekStartCash = ScaledDecimal.zero();
      let feesToday = ScaledDecimal.zero();

      let hasDayStart = false;
      let hasWeekStart = false;

      for (const row of rows) {
        const amt = ScaledDecimal.fromString(row.amount_usdt);
        if (row.debit_account === "cash:usdt") {
          runningCash = runningCash.add(amt);
        } else if (row.credit_account === "cash:usdt") {
          runningCash = runningCash.sub(amt);
        }

        if (runningCash.gt(hwm)) {
          hwm = runningCash;
        }

        if (row.ts <= dayStartMs) {
          dayStartCash = runningCash;
          hasDayStart = true;
        } else {
          if (row.debit_account === "fees_expense:usdt") {
            feesToday = feesToday.add(amt);
          }
        }

        if (row.ts <= weekStartMs) {
          weekStartCash = runningCash;
          hasWeekStart = true;
        }
      }

      if (!hasDayStart) {
        dayStartCash = runningCash;
      }
      if (!hasWeekStart) {
        weekStartCash = runningCash;
      }

      const currentEquity = runningCash.add(unrealized);
      const snapshotStrategyKey = strategyId ?? "";

      // Record/deduplicate snapshot of current equity to preserve intra-period mark-to-market state
      db.prepare(
        `INSERT INTO ledger_equity_snapshots (strategy_id, ts, equity_usdt)
         VALUES (?, ?, ?)
         ON CONFLICT(strategy_id, ts) DO UPDATE SET equity_usdt = excluded.equity_usdt`
      ).run(snapshotStrategyKey, asOfMs, currentEquity.toFixed(8));

      // Query historical equity snapshots up to asOfMs strictly segregated by strategyKey
      const snapshotRows = db
        .prepare(
          `SELECT equity_usdt FROM ledger_equity_snapshots
           WHERE strategy_id = ? AND ts <= ?`
        )
        .all(snapshotStrategyKey, asOfMs) as {
        equity_usdt: string;
      }[];
      for (const sRow of snapshotRows) {
        const sEquity = ScaledDecimal.fromString(sRow.equity_usdt);
        if (sEquity.gt(hwm)) {
          hwm = sEquity;
        }
      }

      if (currentEquity.gt(hwm)) {
        hwm = currentEquity;
      }

      let drawdownPct = ScaledDecimal.zero();
      if (hwm.isPositive() && currentEquity.lt(hwm)) {
        const diff = hwm.sub(currentEquity);
        drawdownPct = diff.mul(ScaledDecimal.fromString("100")).divFloor(hwm);
      }

      return {
        currentEquityUsdt: currentEquity,
        dayStartEquityUsdt: dayStartCash,
        weekStartEquityUsdt: weekStartCash,
        highWaterMarkEquityUsdt: hwm,
        feesTodayUsdt: feesToday,
        drawdownPct
      };
    }
  };
}

export function createPaperAccountRepository(db: DatabaseSync): PaperAccountRepository {
  // Initialize default CircuitBreaker state if empty
  const cbRow = db.prepare("SELECT COUNT(*) AS cnt FROM circuit_breaker_state").get();
  if (Number(cbRow?.["cnt"] ?? 0) === 0) {
    db.prepare(
      `INSERT INTO circuit_breaker_state (id, status, reason, triggered_at_ms, cooldown_until_ms, updated_by)
       VALUES (1, 'NORMAL', 'Initial system state nominal', 0, NULL, 'system')`
    ).run();
  }

  return {
    savePosition(position: PaperPositionRecord): PaperPositionRecord {
      db.prepare(
        `INSERT INTO paper_positions (
          position_id, strategy_id, instrument_id, side, contracts, entry_price, protective_stop_price,
          take_profit_price, initial_risk_usdt, unrealized_pnl_usdt, realized_pnl_usdt, fees_paid_usdt,
          funding_paid_usdt, opened_at_ms, last_funding_settled_ts, status, closed_at_ms, exit_price, exit_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(position_id) DO UPDATE SET
          contracts = excluded.contracts,
          entry_price = excluded.entry_price,
          protective_stop_price = excluded.protective_stop_price,
          take_profit_price = excluded.take_profit_price,
          initial_risk_usdt = excluded.initial_risk_usdt,
          unrealized_pnl_usdt = excluded.unrealized_pnl_usdt,
          realized_pnl_usdt = excluded.realized_pnl_usdt,
          fees_paid_usdt = excluded.fees_paid_usdt,
          funding_paid_usdt = excluded.funding_paid_usdt,
          last_funding_settled_ts = excluded.last_funding_settled_ts,
          status = excluded.status,
          closed_at_ms = excluded.closed_at_ms,
          exit_price = excluded.exit_price,
          exit_reason = excluded.exit_reason`
      ).run(
        position.positionId,
        position.strategyId,
        position.instrumentId,
        position.side,
        position.contracts,
        position.entryPrice,
        position.protectiveStopPrice,
        position.takeProfitPrice,
        position.initialRiskUsdt,
        position.unrealizedPnlUsdt,
        position.realizedPnlUsdt,
        position.feesPaidUsdt,
        position.fundingPaidUsdt,
        position.openedAtMs,
        position.lastFundingSettledTs,
        position.status,
        position.closedAtMs,
        position.exitPrice,
        position.exitReason
      );
      return position;
    },

    getPosition(positionId: string): PaperPositionRecord | null {
      const row = db.prepare(`SELECT * FROM paper_positions WHERE position_id = ?`).get(positionId);
      return row ? mapPositionRow(row as Record<string, unknown>) : null;
    },

    listOpenPositions(): readonly PaperPositionRecord[] {
      const rows = db
        .prepare(`SELECT * FROM paper_positions WHERE status = 'OPEN' ORDER BY opened_at_ms DESC`)
        .all();
      return rows.map((r) => mapPositionRow(r as Record<string, unknown>));
    },

    listAllPositions(limit = 100): readonly PaperPositionRecord[] {
      const rows = db
        .prepare(`SELECT * FROM paper_positions ORDER BY opened_at_ms DESC LIMIT ?`)
        .all(limit);
      return rows.map((r) => mapPositionRow(r as Record<string, unknown>));
    },

    saveOrder(order: PaperOrderRecord): PaperOrderRecord {
      db.prepare(
        `INSERT INTO paper_orders (
          order_id, position_id, proposal_id, strategy_id, instrument_id, side, order_role,
          contracts, fill_price, protective_stop_price, fee_usdt, status, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        order.orderId,
        order.positionId,
        order.proposalId,
        order.strategyId,
        order.instrumentId,
        order.side,
        order.orderRole,
        order.contracts,
        order.fillPrice,
        order.protectiveStopPrice,
        order.feeUsdt,
        order.status,
        order.createdAtMs
      );
      return order;
    },

    listOrders(limit = 100): readonly PaperOrderRecord[] {
      const rows = db
        .prepare(`SELECT * FROM paper_orders ORDER BY created_at_ms DESC LIMIT ?`)
        .all(limit);
      return rows.map((r) => mapOrderRow(r as Record<string, unknown>));
    },

    countFilledOrdersToday(params: {
      readonly sinceMs: number;
      readonly strategyId?: string | null | undefined;
    }): number {
      let query = `SELECT COUNT(*) AS cnt FROM paper_orders WHERE status = 'FILLED' AND order_role = 'ENTRY' AND created_at_ms >= ?`;
      const queryParams: unknown[] = [params.sinceMs];
      if (params.strategyId) {
        query += ` AND strategy_id = ?`;
        queryParams.push(params.strategyId);
      }
      const row = db.prepare(query).get(...queryParams) as { cnt: number } | undefined;
      return Number(row?.cnt ?? 0);
    },

    getCircuitBreaker(): CircuitBreakerRecord {
      const row = db.prepare(`SELECT * FROM circuit_breaker_state WHERE id = 1`).get() as Record<
        string,
        unknown
      >;
      return CircuitBreakerRecordSchema.parse({
        status: String(row["status"]),
        reason: String(row["reason"]),
        triggeredAtMs: Number(row["triggered_at_ms"]),
        cooldownUntilMs:
          row["cooldown_until_ms"] === null ? null : Number(row["cooldown_until_ms"]),
        updatedBy: String(row["updated_by"])
      });
    },

    setCircuitBreaker(record: CircuitBreakerRecord): CircuitBreakerRecord {
      db.prepare(
        `UPDATE circuit_breaker_state
         SET status = ?, reason = ?, triggered_at_ms = ?, cooldown_until_ms = ?, updated_by = ?
         WHERE id = 1`
      ).run(
        record.status,
        record.reason,
        record.triggeredAtMs,
        record.cooldownUntilMs,
        record.updatedBy
      );
      return record;
    },

    getLastProcessedBarCloseTs(params: {
      readonly instrumentId: string;
      readonly strategyId: string;
    }): number | null {
      const row = db
        .prepare(
          `SELECT close_ts FROM paper_processed_bars WHERE instrument_id = ? AND strategy_id = ?`
        )
        .get(params.instrumentId, params.strategyId) as { close_ts: number } | undefined;
      return row ? Number(row.close_ts) : null;
    },

    recordProcessedBar(params: {
      readonly instrumentId: string;
      readonly strategyId: string;
      readonly closeTs: number;
    }): void {
      db.prepare(
        `INSERT INTO paper_processed_bars (instrument_id, strategy_id, close_ts)
         VALUES (?, ?, ?)
         ON CONFLICT(instrument_id, strategy_id) DO UPDATE SET close_ts = excluded.close_ts`
      ).run(params.instrumentId, params.strategyId, params.closeTs);
    },

    getPendingProposal(params: {
      readonly strategyId: string;
      readonly instrumentId: string;
    }): Proposal | null {
      const row = db
        .prepare(
          `SELECT proposal_json FROM paper_pending_proposals WHERE strategy_id = ? AND instrument_id = ?`
        )
        .get(params.strategyId, params.instrumentId) as { proposal_json: string } | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.proposal_json) as unknown;
        return ProposalSchema.parse(parsed);
      } catch {
        return null;
      }
    },

    savePendingProposal(params: {
      readonly strategyId: string;
      readonly instrumentId: string;
      readonly proposal: Proposal | null;
    }): void {
      if (params.proposal === null) {
        db.prepare(
          `DELETE FROM paper_pending_proposals WHERE strategy_id = ? AND instrument_id = ?`
        ).run(params.strategyId, params.instrumentId);
      } else {
        db.prepare(
          `INSERT INTO paper_pending_proposals (strategy_id, instrument_id, proposal_json)
           VALUES (?, ?, ?)
           ON CONFLICT(strategy_id, instrument_id) DO UPDATE SET proposal_json = excluded.proposal_json`
        ).run(params.strategyId, params.instrumentId, JSON.stringify(params.proposal));
      }
    }
  };
}

export function createPromotionRepository(db: DatabaseSync): PromotionRepository {
  return {
    upsertPromotion(record: StrategyPromotionRecord): StrategyPromotionRecord {
      const promotedAt = record.promotedAtMs ?? record.updatedAtMs;
      db.prepare(
        `INSERT INTO strategy_promotions (
          strategy_id, current_stage, latest_experiment_id, replay_gate_passed,
          paper_trades_count, paper_drawdown_pct, eligible_next_stage, demotion_reason, promoted_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(strategy_id) DO UPDATE SET
          current_stage = excluded.current_stage,
          latest_experiment_id = excluded.latest_experiment_id,
          replay_gate_passed = excluded.replay_gate_passed,
          paper_trades_count = excluded.paper_trades_count,
          paper_drawdown_pct = excluded.paper_drawdown_pct,
          eligible_next_stage = excluded.eligible_next_stage,
          demotion_reason = excluded.demotion_reason,
          promoted_at_ms = excluded.promoted_at_ms,
          updated_at_ms = excluded.updated_at_ms`
      ).run(
        record.strategyId,
        record.currentStage,
        record.latestExperimentId,
        record.replayGatePassed ? 1 : 0,
        record.paperTradesCount,
        record.paperDrawdownPct,
        record.eligibleNextStage,
        record.demotionReason,
        promotedAt,
        record.updatedAtMs
      );
      return { ...record, promotedAtMs: promotedAt };
    },

    getPromotion(strategyId: string): StrategyPromotionRecord | null {
      const row = db
        .prepare(`SELECT * FROM strategy_promotions WHERE strategy_id = ?`)
        .get(strategyId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return StrategyPromotionRecordSchema.parse({
        strategyId: String(row["strategy_id"]),
        currentStage: PromotionStageSchema.parse(String(row["current_stage"])),
        latestExperimentId:
          row["latest_experiment_id"] === null ? null : String(row["latest_experiment_id"]),
        replayGatePassed: Number(row["replay_gate_passed"]) === 1,
        paperTradesCount: Number(row["paper_trades_count"]),
        paperDrawdownPct: Number(row["paper_drawdown_pct"]),
        eligibleNextStage:
          row["eligible_next_stage"] === null
            ? null
            : PromotionStageSchema.parse(String(row["eligible_next_stage"])),
        demotionReason: row["demotion_reason"] === null ? null : String(row["demotion_reason"]),
        promotedAtMs:
          row["promoted_at_ms"] !== null && row["promoted_at_ms"] !== undefined
            ? Number(row["promoted_at_ms"])
            : Number(row["updated_at_ms"]),
        updatedAtMs: Number(row["updated_at_ms"])
      });
    },

    listPromotions(): readonly StrategyPromotionRecord[] {
      const rows = db
        .prepare(`SELECT * FROM strategy_promotions ORDER BY strategy_id ASC`)
        .all() as Record<string, unknown>[];
      return rows.map((row) =>
        StrategyPromotionRecordSchema.parse({
          strategyId: String(row["strategy_id"]),
          currentStage: PromotionStageSchema.parse(String(row["current_stage"])),
          latestExperimentId:
            row["latest_experiment_id"] === null ? null : String(row["latest_experiment_id"]),
          replayGatePassed: Number(row["replay_gate_passed"]) === 1,
          paperTradesCount: Number(row["paper_trades_count"]),
          paperDrawdownPct: Number(row["paper_drawdown_pct"]),
          eligibleNextStage:
            row["eligible_next_stage"] === null
              ? null
              : PromotionStageSchema.parse(String(row["eligible_next_stage"])),
          demotionReason: row["demotion_reason"] === null ? null : String(row["demotion_reason"]),
          promotedAtMs:
            row["promoted_at_ms"] !== null && row["promoted_at_ms"] !== undefined
              ? Number(row["promoted_at_ms"])
              : Number(row["updated_at_ms"]),
          updatedAtMs: Number(row["updated_at_ms"])
        })
      );
    }
  };
}
