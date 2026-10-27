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
  ShadowDecisionRecordSchema,
  StrategyPromotionRecordSchema,
  computeNextBarOpenEntry,
  evaluateIntrabarExit,
  getUtcDayStartMs,
  getUtcWeekStartMs,
  type CircuitBreakerRecord,
  type LedgerEntryRecord,
  type LedgerRepository,
  type LedgerRiskMetrics,
  type LedgerTrialBalance,
  type MarketDataRepository,
  type NewLedgerJournalInput,
  type PaperAccountRepository,
  type PaperOrderRecord,
  type PaperPositionRecord,
  type PromotionRepository,
  type Proposal,
  type RecordShadowDecisionInput,
  type ShadowDecisionRecord,
  type ShadowRepository,
  type ShadowStats,
  type StrategyPromotionRecord
} from "@keel/core";

/**
 * Paper (simulated) and exchange (real venue) trading are kept in separate ledger, position and
 * order tables so simulated fills can never touch real positions or the equity live risk sizes
 * against (audit-3 C2). The circuit breaker stays shared: one Kill Switch stops both books.
 */
export type TradingBook = "paper" | "exchange";

export interface BookTables {
  readonly ledger: string;
  readonly equitySnapshots: string;
  readonly positions: string;
  readonly orders: string;
}

export function bookTables(book: TradingBook): BookTables {
  return book === "paper"
    ? {
        ledger: "ledger_entries",
        equitySnapshots: "ledger_equity_snapshots",
        positions: "paper_positions",
        orders: "paper_orders"
      }
    : {
        ledger: "exchange_ledger_entries",
        equitySnapshots: "exchange_ledger_equity_snapshots",
        positions: "exchange_positions",
        orders: "exchange_orders"
      };
}

export function bookSchemaSql(book: TradingBook): string {
  const t = bookTables(book);
  return `
CREATE TABLE IF NOT EXISTS ${t.ledger} (
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

CREATE INDEX IF NOT EXISTS idx_${t.ledger}_ts ON ${t.ledger}(ts DESC);
CREATE INDEX IF NOT EXISTS idx_${t.ledger}_tx_group ON ${t.ledger}(tx_group_id);

CREATE TABLE IF NOT EXISTS ${t.positions} (
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

CREATE INDEX IF NOT EXISTS idx_${t.positions}_status ON ${t.positions}(status);

CREATE TABLE IF NOT EXISTS ${t.orders} (
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

CREATE INDEX IF NOT EXISTS idx_${t.orders}_created ON ${t.orders}(created_at_ms DESC);

CREATE TABLE IF NOT EXISTS ${t.equitySnapshots} (
  strategy_id TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  equity_usdt TEXT NOT NULL,
  PRIMARY KEY (strategy_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_${t.equitySnapshots} ON ${t.equitySnapshots}(strategy_id, ts ASC);
`;
}

export const PAPER_SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS shadow_decisions (
  decision_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  signal_bar_open_ts INTEGER NOT NULL,
  signal_bar_close_ts INTEGER NOT NULL,
  proposal_id TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price TEXT NOT NULL,
  protective_stop_price TEXT NOT NULL,
  take_profit_price TEXT,
  status TEXT NOT NULL,
  resolved_r REAL,
  resolved_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (strategy_id, instrument_id, signal_bar_close_ts)
);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_lookup ON shadow_decisions(strategy_id, status);

CREATE TABLE IF NOT EXISTS scheduler_anchors (
  instrument_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  anchor_close_ts INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, strategy_id)
);
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
  initialEquityUsdt = "10000.00000000",
  book: TradingBook = "paper"
): LedgerRepository {
  const t = bookTables(book);
  // Seed initial equity capital if ledger is completely empty
  const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ${t.ledger}`).get();
  const count = Number(countRow?.["cnt"] ?? 0);
  if (count === 0) {
    db.prepare(
      `INSERT INTO ${t.ledger} (
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
      book === "paper"
        ? "Initial paper portfolio capital seed"
        : "Initial exchange book capital seed (configured, reconcile to venue balance)"
    );
  }

  return {
    recordJournal(input: NewLedgerJournalInput): LedgerEntryRecord {
      const amountDec = ScaledDecimal.fromString(input.amountUsdt);
      if (!amountDec.isPositive()) {
        throw new Error("Ledger journal amount must be strictly positive");
      }
      const seqRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ${t.ledger}`).get();
      const seq = Number(seqRow?.["cnt"] ?? 0) + 1;
      const entryId = `entry-${input.txGroupId}-${input.ts}-${seq}`;
      db.prepare(
        `INSERT INTO ${t.ledger} (
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
           FROM ${t.ledger} ORDER BY ts DESC, entry_id DESC LIMIT ?`
        )
        .all(limit);
      return rows.map((r) => mapLedgerRow(r as Record<string, unknown>));
    },

    getTrialBalance(): LedgerTrialBalance {
      const rows = db
        .prepare(`SELECT debit_account, credit_account, amount_usdt FROM ${t.ledger}`)
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
                   FROM ${t.ledger}
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

      // Query historical equity snapshots up to asOfMs strictly segregated by strategyKey
      const snapshotRows = db
        .prepare(
          `SELECT equity_usdt FROM ${t.equitySnapshots}
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

      // Check if snapshots exist for dayStart and weekStart to capture intra-period equity peaks
      const dayStartSnapshot = db
        .prepare(
          `SELECT equity_usdt FROM ${t.equitySnapshots}
           WHERE strategy_id = ? AND ts <= ?
           ORDER BY ts DESC LIMIT 1`
        )
        .get(snapshotStrategyKey, dayStartMs) as { equity_usdt: string } | undefined;
      const effectiveDayStartEquity = dayStartSnapshot
        ? ScaledDecimal.fromString(dayStartSnapshot.equity_usdt)
        : dayStartCash;

      const weekStartSnapshot = db
        .prepare(
          `SELECT equity_usdt FROM ${t.equitySnapshots}
           WHERE strategy_id = ? AND ts <= ?
           ORDER BY ts DESC LIMIT 1`
        )
        .get(snapshotStrategyKey, weekStartMs) as { equity_usdt: string } | undefined;
      const effectiveWeekStartEquity = weekStartSnapshot
        ? ScaledDecimal.fromString(weekStartSnapshot.equity_usdt)
        : weekStartCash;

      let drawdownPct = ScaledDecimal.zero();
      if (hwm.isPositive() && currentEquity.lt(hwm)) {
        const diff = hwm.sub(currentEquity);
        drawdownPct = diff.mul(ScaledDecimal.fromString("100")).divFloor(hwm);
      }

      return {
        currentEquityUsdt: currentEquity,
        dayStartEquityUsdt: effectiveDayStartEquity,
        weekStartEquityUsdt: effectiveWeekStartEquity,
        highWaterMarkEquityUsdt: hwm,
        feesTodayUsdt: feesToday,
        drawdownPct
      };
    },

    recordEquitySnapshot(params: {
      readonly ts: number;
      readonly strategyId?: string | null | undefined;
      readonly equityUsdt: ScaledDecimal;
    }): void {
      const snapshotStrategyKey = params.strategyId ?? "";
      db.prepare(
        `INSERT INTO ${t.equitySnapshots} (strategy_id, ts, equity_usdt)
         VALUES (?, ?, ?)
         ON CONFLICT(strategy_id, ts) DO UPDATE SET equity_usdt = excluded.equity_usdt`
      ).run(snapshotStrategyKey, params.ts, params.equityUsdt.toFixed(8));
    }
  };
}

export function createPaperAccountRepository(
  db: DatabaseSync,
  book: TradingBook = "paper"
): PaperAccountRepository {
  const t = bookTables(book);
  // Initialize default CircuitBreaker state if empty
  const cbRow = db.prepare(`SELECT COUNT(*) AS cnt FROM circuit_breaker_state`).get();
  if (Number(cbRow?.["cnt"] ?? 0) === 0) {
    db.prepare(
      `INSERT INTO circuit_breaker_state (id, status, reason, triggered_at_ms, cooldown_until_ms, updated_by)
       VALUES (1, 'NORMAL', 'Initial system state nominal', 0, NULL, 'system')`
    ).run();
  }

  return {
    savePosition(position: PaperPositionRecord): PaperPositionRecord {
      db.prepare(
        `INSERT INTO ${t.positions} (
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
      const row = db.prepare(`SELECT * FROM ${t.positions} WHERE position_id = ?`).get(positionId);
      return row ? mapPositionRow(row as Record<string, unknown>) : null;
    },

    listOpenPositions(): readonly PaperPositionRecord[] {
      const rows = db
        .prepare(`SELECT * FROM ${t.positions} WHERE status = 'OPEN' ORDER BY opened_at_ms DESC`)
        .all();
      return rows.map((r) => mapPositionRow(r as Record<string, unknown>));
    },

    listAllPositions(limit = 100): readonly PaperPositionRecord[] {
      const rows = db
        .prepare(`SELECT * FROM ${t.positions} ORDER BY opened_at_ms DESC LIMIT ?`)
        .all(limit);
      return rows.map((r) => mapPositionRow(r as Record<string, unknown>));
    },

    saveOrder(order: PaperOrderRecord): PaperOrderRecord {
      db.prepare(
        `INSERT INTO ${t.orders} (
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
        .prepare(`SELECT * FROM ${t.orders} ORDER BY created_at_ms DESC LIMIT ?`)
        .all(limit);
      return rows.map((r) => mapOrderRow(r as Record<string, unknown>));
    },

    countFilledOrdersToday(params: {
      readonly sinceMs: number;
      readonly strategyId?: string | null | undefined;
    }): number {
      let query = `SELECT COUNT(*) AS cnt FROM ${t.orders} WHERE status = 'FILLED' AND order_role = 'ENTRY' AND created_at_ms >= ?`;
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
    },

    getSchedulerAnchor(params: {
      readonly instrumentId: string;
      readonly strategyId: string;
    }): number | null {
      const row = db
        .prepare(
          `SELECT anchor_close_ts FROM scheduler_anchors WHERE instrument_id = ? AND strategy_id = ?`
        )
        .get(params.instrumentId, params.strategyId) as { anchor_close_ts: number } | undefined;
      return row ? Number(row.anchor_close_ts) : null;
    },

    setSchedulerAnchor(params: {
      readonly instrumentId: string;
      readonly strategyId: string;
      readonly anchorCloseTs: number;
      readonly createdAtMs?: number | undefined;
    }): void {
      db.prepare(
        `INSERT INTO scheduler_anchors (instrument_id, strategy_id, anchor_close_ts, created_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(instrument_id, strategy_id) DO UPDATE SET
           anchor_close_ts = excluded.anchor_close_ts`
      ).run(
        params.instrumentId,
        params.strategyId,
        params.anchorCloseTs,
        params.createdAtMs ?? Date.now()
      );
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

function mapShadowRow(row: Record<string, unknown>): ShadowDecisionRecord {
  return ShadowDecisionRecordSchema.parse({
    decisionId: String(row["decision_id"]),
    strategyId: String(row["strategy_id"]),
    instrumentId: String(row["instrument_id"]),
    signalBarOpenTs: Number(row["signal_bar_open_ts"]),
    signalBarCloseTs: Number(row["signal_bar_close_ts"]),
    proposalId: String(row["proposal_id"]),
    side: row["side"] === "short" ? "short" : "long",
    entryPrice: String(row["entry_price"]),
    protectiveStopPrice: String(row["protective_stop_price"]),
    takeProfitPrice: row["take_profit_price"] === null ? null : String(row["take_profit_price"]),
    status: row["status"] === "RESOLVED" ? "RESOLVED" : "PENDING",
    resolvedR:
      row["resolved_r"] === null || row["resolved_r"] === undefined
        ? null
        : Number(row["resolved_r"]),
    resolvedAtMs:
      row["resolved_at_ms"] === null || row["resolved_at_ms"] === undefined
        ? null
        : Number(row["resolved_at_ms"]),
    createdAtMs: Number(row["created_at_ms"])
  });
}

export function createShadowRepository(db: DatabaseSync): ShadowRepository {
  return {
    recordDecision(input: RecordShadowDecisionInput): boolean {
      const decisionId = `shadow-${input.strategyId}-${input.instrumentId}-${input.signalBarCloseTs}`;
      const res = db
        .prepare(
          `INSERT INTO shadow_decisions (
            decision_id, strategy_id, instrument_id, signal_bar_open_ts, signal_bar_close_ts,
            proposal_id, side, entry_price, protective_stop_price, take_profit_price,
            status, resolved_r, resolved_at_ms, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, ?)
          ON CONFLICT(strategy_id, instrument_id, signal_bar_close_ts) DO NOTHING`
        )
        .run(
          decisionId,
          input.strategyId,
          input.instrumentId,
          input.signalBarOpenTs,
          input.signalBarCloseTs,
          input.proposalId,
          input.side,
          input.entryPrice,
          input.protectiveStopPrice,
          input.takeProfitPrice ?? null,
          input.createdAtMs
        );
      return Number(res.changes) > 0;
    },

    getPendingDecisions(strategyId?: string): readonly ShadowDecisionRecord[] {
      const sql = strategyId
        ? `SELECT * FROM shadow_decisions WHERE status = 'PENDING' AND strategy_id = ? ORDER BY signal_bar_close_ts ASC`
        : `SELECT * FROM shadow_decisions WHERE status = 'PENDING' ORDER BY signal_bar_close_ts ASC`;
      const rows = (strategyId ? db.prepare(sql).all(strategyId) : db.prepare(sql).all()) as Record<
        string,
        unknown
      >[];
      return rows.map(mapShadowRow);
    },

    resolveDecision(input: {
      readonly decisionId: string;
      readonly resolvedR: number;
      readonly resolvedAtMs: number;
    }): void {
      db.prepare(
        `UPDATE shadow_decisions
         SET status = 'RESOLVED', resolved_r = ?, resolved_at_ms = ?
         WHERE decision_id = ?`
      ).run(input.resolvedR, input.resolvedAtMs, input.decisionId);
    },

    resolvePendingDecisions(params: {
      readonly marketDataRepo: MarketDataRepository;
      readonly slippageBps?: number | undefined;
    }): number {
      const pending = this.getPendingDecisions();
      if (pending.length === 0) return 0;

      let resolvedCount = 0;
      const slippageBps = params.slippageBps ?? 0;

      for (const dec of pending) {
        const subsequentBars = params.marketDataRepo.getConfirmedBarsInRange({
          instrumentId: dec.instrumentId,
          timeframe: "1H",
          fromOpenTs: dec.signalBarCloseTs,
          toCloseTs: Number.MAX_SAFE_INTEGER
        });

        if (subsequentBars.length === 0) continue;

        const entryBar = subsequentBars[0];
        if (!entryBar) continue;

        const proposedEntry = ScaledDecimal.fromString(dec.entryPrice);
        const proposedStop = ScaledDecimal.fromString(dec.protectiveStopPrice);
        const proposedTp = dec.takeProfitPrice
          ? ScaledDecimal.fromString(dec.takeProfitPrice)
          : null;

        const entryExec = computeNextBarOpenEntry({
          side: dec.side,
          barOpen: ScaledDecimal.fromString(entryBar.open),
          slippageBps,
          proposedEntryPrice: proposedEntry,
          proposedStopPrice: proposedStop,
          proposedTpPrice: proposedTp
        });

        const entryPrice = entryExec.entryPrice;
        const effectiveStopPrice = entryExec.effectiveStopPrice;
        const effectiveTpPrice = entryExec.effectiveTpPrice;

        const initialRisk =
          dec.side === "long"
            ? entryPrice.sub(effectiveStopPrice)
            : effectiveStopPrice.sub(entryPrice);

        for (const bar of subsequentBars) {
          const exitRes = evaluateIntrabarExit({
            side: dec.side,
            barOpen: ScaledDecimal.fromString(bar.open),
            barHigh: ScaledDecimal.fromString(bar.high),
            barLow: ScaledDecimal.fromString(bar.low),
            stopPrice: effectiveStopPrice,
            tpPrice: effectiveTpPrice,
            slippageBps
          });

          if (exitRes.closed && exitRes.exitPrice) {
            const pnl =
              dec.side === "long"
                ? exitRes.exitPrice.sub(entryPrice)
                : entryPrice.sub(exitRes.exitPrice);

            const resolvedR = initialRisk.isPositive()
              ? Number(pnl.toScaledBigInt()) / Number(initialRisk.toScaledBigInt())
              : 0;

            this.resolveDecision({
              decisionId: dec.decisionId,
              resolvedR: Number(resolvedR.toFixed(4)),
              resolvedAtMs: bar.closeTs
            });
            resolvedCount++;
            break;
          }
        }
      }

      return resolvedCount;
    },

    getShadowStats(strategyId: string): ShadowStats {
      const row = db
        .prepare(
          `SELECT
             COUNT(CASE WHEN status = 'RESOLVED' THEN 1 END) AS resolved_cnt,
             COUNT(CASE WHEN status = 'PENDING' THEN 1 END) AS pending_cnt,
             COUNT(*) AS total_cnt,
             AVG(CASE WHEN status = 'RESOLVED' THEN resolved_r END) AS avg_r,
             COUNT(CASE WHEN status = 'RESOLVED' AND resolved_r > 0 THEN 1 END) AS win_cnt
           FROM shadow_decisions
           WHERE strategy_id = ?`
        )
        .get(strategyId) as Record<string, unknown> | undefined;

      const resolvedCount = Number(row?.["resolved_cnt"] ?? 0);
      const pendingCount = Number(row?.["pending_cnt"] ?? 0);
      const totalDecisions = Number(row?.["total_cnt"] ?? 0);
      const expectancyR =
        row?.["avg_r"] !== null && row?.["avg_r"] !== undefined ? Number(row["avg_r"]) : 0;
      const winCount = Number(row?.["win_cnt"] ?? 0);
      const winRate = resolvedCount > 0 ? winCount / resolvedCount : 0;

      return {
        resolvedCount,
        pendingCount,
        totalDecisions,
        expectancyR,
        winRate
      };
    },

    listDecisions(strategyId?: string, limit = 100): readonly ShadowDecisionRecord[] {
      const sql = strategyId
        ? `SELECT * FROM shadow_decisions WHERE strategy_id = ? ORDER BY signal_bar_close_ts DESC LIMIT ?`
        : `SELECT * FROM shadow_decisions ORDER BY signal_bar_close_ts DESC LIMIT ?`;
      const rows = (
        strategyId ? db.prepare(sql).all(strategyId, limit) : db.prepare(sql).all(limit)
      ) as Record<string, unknown>[];
      return rows.map(mapShadowRow);
    }
  };
}
