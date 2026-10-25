import { createHmac } from "node:crypto";
import {
  createDefaultConfig,
  defaultInstrumentSpec,
  sha256Hex,
  ScaledDecimal,
  type Clock,
  type CircuitBreakerRecord,
  type ConfirmedBar,
  type DmsStatus,
  type ExchangeBroker,
  type ExchangeOrderInput,
  type ExchangeOrderResult,
  type NotificationChannel,
  type PaperOrderRecord,
  type PaperPositionRecord,
  type PaperTickResult,
  type ReconciliationResult,
  type RiskConfig,
  type PaperAccountRepository,
  type LedgerRepository,
  type MarketDataRepository
} from "@keel/core";

export interface OkxCredentials {
  readonly apiKey: string;
  readonly secretKey: string;
  readonly passphrase: string;
}

export interface OkxFetchFn {
  (
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body?: string | undefined;
    }
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface OkxBrokerOptions {
  readonly clock: Clock;
  readonly getRiskConfig?: (() => RiskConfig) | undefined;
  readonly getCredentials?: (() => OkxCredentials | null) | undefined;
  readonly isDemo?: boolean | undefined;
  readonly fetchFn?: OkxFetchFn | undefined;
  readonly notificationChannel?: NotificationChannel | undefined;
  readonly accountRepo?: PaperAccountRepository | undefined;
  readonly ledgerRepo?: LedgerRepository | undefined;
  readonly marketDataRepo?: MarketDataRepository | undefined;
}

export function buildOkxHeaders(params: {
  readonly method: string;
  readonly path: string;
  readonly body?: string | undefined;
  readonly credentials: OkxCredentials;
  readonly timestampIso: string;
  readonly isDemo?: boolean | undefined;
}): Record<string, string> {
  const prehash = `${params.timestampIso}${params.method.toUpperCase()}${params.path}${params.body ?? ""}`;
  const sign = createHmac("sha256", params.credentials.secretKey).update(prehash).digest("base64");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": params.credentials.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": params.timestampIso,
    "OK-ACCESS-PASSPHRASE": params.credentials.passphrase
  };

  if (params.isDemo === true) {
    headers["x-simulated-trading"] = "1";
  }

  return headers;
}

export class OkxBroker implements ExchangeBroker {
  private readonly clock: Clock;
  private readonly getRiskConfig: () => RiskConfig;
  private readonly getCredentials: () => OkxCredentials | null;
  private readonly isDemo: boolean;
  private readonly fetchFn: OkxFetchFn;
  private readonly notificationChannel: NotificationChannel | null;
  private accountRepo: PaperAccountRepository | null;
  private ledgerRepo: LedgerRepository | null;
  private marketDataRepo: MarketDataRepository | null;

  private circuitBreaker: CircuitBreakerRecord = {
    status: "NORMAL",
    reason: "Initial startup state",
    triggeredAtMs: 0,
    cooldownUntilMs: null,
    updatedBy: "system"
  };

  private dmsLastHeartbeatAtMs: number | null = null;
  private localPositions: Map<string, PaperPositionRecord> = new Map();
  private localOrders: PaperOrderRecord[] = [];

  public constructor(options: OkxBrokerOptions) {
    this.clock = options.clock;
    this.getRiskConfig = options.getRiskConfig ?? (() => createDefaultConfig().risk);
    this.getCredentials = options.getCredentials ?? (() => null);
    this.isDemo = options.isDemo ?? true;
    this.notificationChannel = options.notificationChannel ?? null;
    this.accountRepo = options.accountRepo ?? null;
    this.ledgerRepo = options.ledgerRepo ?? null;
    this.marketDataRepo = options.marketDataRepo ?? null;

    if (this.accountRepo) {
      this.circuitBreaker = this.accountRepo.getCircuitBreaker();
      const open = this.accountRepo.listOpenPositions();
      for (const pos of open) {
        this.localPositions.set(pos.positionId, pos);
      }
      this.localOrders = [...this.accountRepo.listOrders(100)];
    }

    this.fetchFn =
      options.fetchFn ??
      (async (url, init) => {
        const fetchInit: RequestInit = {
          method: init.method,
          headers: init.headers
        };
        if (init.body !== undefined) {
          fetchInit.body = init.body;
        }
        const res = await fetch(url, fetchInit);
        return {
          ok: res.ok,
          status: res.status,
          json: () => res.json(),
          text: () => res.text()
        };
      });
  }

  public setRepositories(repos: {
    readonly accountRepo?: PaperAccountRepository | undefined;
    readonly ledgerRepo?: LedgerRepository | undefined;
    readonly marketDataRepo?: MarketDataRepository | undefined;
  }): void {
    if (!this.accountRepo && repos.accountRepo) {
      this.accountRepo = repos.accountRepo;
      this.circuitBreaker = this.accountRepo.getCircuitBreaker();
      const open = this.accountRepo.listOpenPositions();
      for (const pos of open) {
        this.localPositions.set(pos.positionId, pos);
      }
      this.localOrders = [...this.accountRepo.listOrders(100)];
    }
    if (!this.ledgerRepo && repos.ledgerRepo) {
      this.ledgerRepo = repos.ledgerRepo;
    }
    if (!this.marketDataRepo && repos.marketDataRepo) {
      this.marketDataRepo = repos.marketDataRepo;
    }
  }

  public getCircuitBreaker(): CircuitBreakerRecord {
    return { ...this.circuitBreaker };
  }

  public setCircuitBreaker(record: CircuitBreakerRecord): CircuitBreakerRecord {
    this.circuitBreaker = { ...record };
    if (this.accountRepo) {
      this.accountRepo.setCircuitBreaker(this.circuitBreaker);
    }
    return this.getCircuitBreaker();
  }

  public getOpenPositions(): readonly PaperPositionRecord[] {
    const nowMs = this.clock.nowMs();
    if (this.marketDataRepo) {
      for (const [id, pos] of this.localPositions.entries()) {
        if (pos.status === "OPEN") {
          try {
            const bars = this.marketDataRepo.getConfirmedBarsAsOf({
              instrumentId: pos.instrumentId,
              timeframe: "1H",
              asOfMs: nowMs,
              limit: 1
            });
            if (bars && bars.length > 0 && bars[0]) {
              const markPx = ScaledDecimal.fromString(bars[0].close);
              const entryPx = ScaledDecimal.fromString(pos.entryPrice);
              const contracts = ScaledDecimal.fromString(pos.contracts);
              const spec = defaultInstrumentSpec(pos.instrumentId);
              const upl =
                pos.side === "long"
                  ? contracts.mul(spec.contractValue).mul(markPx.sub(entryPx))
                  : contracts.mul(spec.contractValue).mul(entryPx.sub(markPx));

              const updated: PaperPositionRecord = {
                ...pos,
                unrealizedPnlUsdt: upl.toFixed(8)
              };
              this.localPositions.set(id, updated);
              if (this.accountRepo) {
                this.accountRepo.savePosition(updated);
              }
            }
          } catch {
            // Keep existing unrealized PnL if query fails
          }
        }
      }
    }
    return Array.from(this.localPositions.values()).filter((p) => p.status === "OPEN");
  }

  public getAllPositions(limit = 100): readonly PaperPositionRecord[] {
    return Array.from(this.localPositions.values()).slice(0, limit);
  }

  public getOrders(limit = 100): readonly PaperOrderRecord[] {
    return this.localOrders.slice(0, limit);
  }

  public getDmsStatus(): DmsStatus {
    const now = this.clock.nowMs();
    const last = this.dmsLastHeartbeatAtMs;
    const timeoutSeconds = 60;
    const nextHeartbeatDueMs = last !== null ? last + 15_000 : null;
    const isExpired = last !== null && now - last > timeoutSeconds * 1000;

    return {
      enabled: true,
      timeoutSeconds,
      lastHeartbeatAtMs: last,
      nextHeartbeatDueMs,
      healthy: last !== null && !isExpired
    };
  }

  public async sendDmsHeartbeat(): Promise<{ ok: boolean; countdownSeconds: number }> {
    const creds = this.getCredentials();
    const path = "/api/v5/trade/cancel-all-after";
    const body = JSON.stringify({ timeOut: "60" });
    const nowMs = this.clock.nowMs();

    if (creds && creds.apiKey) {
      const headers = buildOkxHeaders({
        method: "POST",
        path,
        body,
        credentials: creds,
        timestampIso: new Date(nowMs).toISOString(),
        isDemo: this.isDemo
      });

      const baseUrl = "https://www.okx.com";

      const res = await this.fetchFn(`${baseUrl}${path}`, {
        method: "POST",
        headers,
        body
      });

      if (!res.ok) {
        const errText = await res.text();
        if (this.notificationChannel) {
          await this.notificationChannel.send({
            severity: "CRITICAL",
            title: "DEAD-MAN SWITCH HEARTBEAT REJECTED",
            body: `OKX DMS API error (${res.status}): ${errText}`,
            dedupKey: `dms-fail-${nowMs}`
          });
        }
        throw new Error(`OKX DMS API error (${res.status}): ${errText}`);
      }

      const resData = (await res.json()) as {
        code?: string;
        msg?: string;
        data?: Array<{
          sCode?: string;
          sMsg?: string;
        }>;
      };

      if (resData.code && resData.code !== "0") {
        if (this.notificationChannel) {
          await this.notificationChannel.send({
            severity: "CRITICAL",
            title: "DEAD-MAN SWITCH HEARTBEAT REJECTED",
            body: `OKX DMS rejected with code ${resData.code}: ${resData.msg ?? "unknown error"}`,
            dedupKey: `dms-fail-${nowMs}`
          });
        }
        throw new Error(`OKX DMS API error (${resData.code}): ${resData.msg ?? "unknown error"}`);
      }

      const item = resData.data?.[0];
      if (item && item.sCode && item.sCode !== "0") {
        if (this.notificationChannel) {
          await this.notificationChannel.send({
            severity: "CRITICAL",
            title: "DEAD-MAN SWITCH HEARTBEAT REJECTED",
            body: `OKX DMS rejected with sCode ${item.sCode}: ${item.sMsg ?? "unknown sub-error"}`,
            dedupKey: `dms-fail-${nowMs}`
          });
        }
        throw new Error(`OKX DMS API error (${item.sCode}): ${item.sMsg ?? "unknown sub-error"}`);
      }
    }

    this.dmsLastHeartbeatAtMs = nowMs;
    return { ok: true, countdownSeconds: 60 };
  }

  public async submitOrder(input: ExchangeOrderInput): Promise<ExchangeOrderResult> {
    // ADR-0006 strict requirement: atomic protective stop is mandatory on all entry orders
    if (!input.protectiveStopPrice || input.protectiveStopPrice.trim() === "") {
      throw new Error(
        "Orders without mandatory attached protective stop are prohibited (ADR-0006)"
      );
    }

    // Exact decimal validation using ScaledDecimal (AGENTS.md)
    const entryPx = ScaledDecimal.fromString(input.entryPrice);
    const stopPx = ScaledDecimal.fromString(input.protectiveStopPrice);

    if (!stopPx.isPositive()) {
      throw new Error("Protective stop price must be strictly positive");
    }

    if (input.side === "long" && stopPx.gte(entryPx)) {
      throw new Error("Long protective stop price must be strictly below entry price");
    }

    if (input.side === "short" && stopPx.lte(entryPx)) {
      throw new Error("Short protective stop price must be strictly above entry price");
    }

    // Validate take-profit if provided (C7)
    let tpPx: ScaledDecimal | null = null;
    if (input.takeProfitPrice && input.takeProfitPrice.trim() !== "") {
      tpPx = ScaledDecimal.fromString(input.takeProfitPrice);
      if (!tpPx.isPositive()) {
        throw new Error("Take-profit price must be strictly positive");
      }
      if (input.side === "long" && tpPx.lte(entryPx)) {
        throw new Error("Long take-profit price must be strictly above entry price");
      }
      if (input.side === "short" && tpPx.gte(entryPx)) {
        throw new Error("Short take-profit price must be strictly below entry price");
      }
    }

    const nowMs = this.clock.nowMs();
    // OKX clOrdId must be alphanumeric ^[a-zA-Z0-9]{1,32}$
    const hash = sha256Hex(`${input.instrumentId}${input.side}${nowMs}`).slice(0, 16);
    const clOrdId =
      input.clOrdId !== undefined
        ? input.clOrdId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)
        : `k${nowMs.toString(36)}${hash}`.slice(0, 32);

    const algoClOrdId = `sl${clOrdId.slice(1, 31)}`;

    // OKX attachAlgoOrds format per ADR-0006 with TP support (C7)
    const attachAlgoOrd: Record<string, unknown> = {
      attachAlgoClOrdId: algoClOrdId,
      slTriggerPx: input.protectiveStopPrice,
      slOrdPx: "-1", // market order execution on trigger
      slTriggerPxType: "mark", // mark price to protect against wicks/manipulation
      reduceOnly: true,
      closeFraction: "1"
    };

    if (tpPx !== null && input.takeProfitPrice) {
      attachAlgoOrd["tpTriggerPx"] = input.takeProfitPrice;
      attachAlgoOrd["tpOrdPx"] = "-1";
      attachAlgoOrd["tpTriggerPxType"] = "mark";
    }

    const attachAlgoOrds = [attachAlgoOrd];

    const orderPayload = {
      instId: input.instrumentId,
      tdMode: "isolated",
      side: input.side === "long" ? "buy" : "sell",
      ordType: "market",
      sz: String(input.sizeLots),
      clOrdId,
      reduceOnly: input.reduceOnly,
      attachAlgoOrds
    };

    const creds = this.getCredentials();
    const path = "/api/v5/trade/order";
    const bodyStr = JSON.stringify(orderPayload);

    let orderId = `ord${clOrdId}`;
    let algoOrderId = `algo${algoClOrdId}`;

    if (creds && creds.apiKey) {
      const headers = buildOkxHeaders({
        method: "POST",
        path,
        body: bodyStr,
        credentials: creds,
        timestampIso: new Date(nowMs).toISOString(),
        isDemo: this.isDemo
      });

      const res = await this.fetchFn(`https://www.okx.com${path}`, {
        method: "POST",
        headers,
        body: bodyStr
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OKX order HTTP ${res.status}: ${errText}`);
      }

      const resData = (await res.json()) as {
        code?: string;
        msg?: string;
        data?: Array<{
          ordId?: string;
          clOrdId?: string;
          sCode?: string;
          sMsg?: string;
          tag?: string;
        }>;
      };

      if (resData.code !== "0") {
        throw new Error(
          `OKX order rejected: code ${resData.code} - ${resData.msg ?? "unknown error"}`
        );
      }

      const item = resData.data?.[0];
      if (!item) {
        throw new Error("OKX order response missing data payload");
      }

      if (item.sCode && item.sCode !== "0") {
        throw new Error(
          `OKX order failed: sCode ${item.sCode} - ${item.sMsg ?? "unknown sub-error"}`
        );
      }

      if (item.ordId) {
        orderId = item.ordId;
      }

      // Query OKX to confirm attached protective stop algo order
      const algoPath = `/api/v5/trade/orders-algo-pending?instId=${encodeURIComponent(input.instrumentId)}&ordType=conditional&algoClOrdId=${encodeURIComponent(algoClOrdId)}`;
      const algoHeaders = buildOkxHeaders({
        method: "GET",
        path: algoPath,
        credentials: creds,
        timestampIso: new Date(nowMs).toISOString(),
        isDemo: this.isDemo
      });

      const algoRes = await this.fetchFn(`https://www.okx.com${algoPath}`, {
        method: "GET",
        headers: algoHeaders
      });

      if (algoRes.ok) {
        const algoData = (await algoRes.json()) as {
          code?: string;
          data?: Array<{
            algoId?: string;
            algoClOrdId?: string;
            state?: string;
          }>;
        };
        const algoItem = algoData.data?.[0];
        if (algoItem?.algoId) {
          algoOrderId = algoItem.algoId;
        }
      }
    }

    const orderResult: ExchangeOrderResult = {
      orderId,
      clOrdId,
      algoOrderId,
      instrumentId: input.instrumentId,
      side: input.side,
      fillPrice: input.entryPrice,
      sizeLots: input.sizeLots,
      protectiveStopPrice: input.protectiveStopPrice,
      status: "FILLED",
      submittedAtMs: nowMs
    };

    // Update local state
    const posId = `pos_${clOrdId}`;
    const effectiveStrategyId = input.strategyId ?? "manual-execution";
    const contractsDec = ScaledDecimal.fromString(String(input.sizeLots));
    const spec = defaultInstrumentSpec(input.instrumentId);
    const initialRisk =
      input.initialRiskUsdt ??
      (input.side === "long" ? entryPx.sub(stopPx) : stopPx.sub(entryPx))
        .mul(contractsDec)
        .mul(spec.contractValue)
        .toFixed(2);

    const notional = contractsDec.mul(spec.contractValue).mul(entryPx);
    const feeRate = ScaledDecimal.fromString("0.0006");
    const entryFee = notional.mul(feeRate);

    if (this.ledgerRepo && entryFee.isPositive()) {
      this.ledgerRepo.recordJournal({
        txGroupId: `open-${posId}`,
        ts: nowMs,
        strategyId: effectiveStrategyId,
        instrumentId: input.instrumentId,
        debitAccount: "fees_expense:usdt",
        creditAccount: "cash:usdt",
        amountUsdt: entryFee.toFixed(8),
        description: `Entry execution fee on exchange order ${orderId}`
      });
    }

    const newPosition: PaperPositionRecord = {
      positionId: posId,
      strategyId: effectiveStrategyId,
      instrumentId: input.instrumentId,
      side: input.side,
      contracts: String(input.sizeLots),
      entryPrice: input.entryPrice,
      protectiveStopPrice: input.protectiveStopPrice,
      takeProfitPrice: input.takeProfitPrice ?? null,
      initialRiskUsdt: initialRisk,
      unrealizedPnlUsdt: "0.00000000",
      realizedPnlUsdt: "0.00000000",
      feesPaidUsdt: entryFee.toFixed(8),
      fundingPaidUsdt: "0.00000000",
      openedAtMs: nowMs,
      lastFundingSettledTs: nowMs,
      status: "OPEN",
      closedAtMs: null,
      exitPrice: null,
      exitReason: null
    };

    this.localPositions.set(posId, newPosition);
    if (this.accountRepo) {
      this.accountRepo.savePosition(newPosition);
    }

    const orderRecord: PaperOrderRecord = {
      orderId,
      positionId: posId,
      proposalId: clOrdId,
      strategyId: effectiveStrategyId,
      instrumentId: input.instrumentId,
      side: input.side,
      orderRole: "ENTRY",
      contracts: String(input.sizeLots),
      fillPrice: input.entryPrice,
      protectiveStopPrice: input.protectiveStopPrice,
      feeUsdt: entryFee.toFixed(8),
      status: "FILLED",
      createdAtMs: nowMs
    };

    this.localOrders.push(orderRecord);
    if (this.accountRepo) {
      this.accountRepo.saveOrder(orderRecord);
    }

    return orderResult;
  }

  /**
   * ADR-0006: Amend attached protective stop during ratcheting without cancelling first.
   */
  public async amendAlgoOrder(params: {
    readonly algoOrderId: string;
    readonly instrumentId: string;
    readonly newStopPrice: string;
  }): Promise<{ ok: boolean; algoOrderId: string; newStopPrice: string }> {
    const creds = this.getCredentials();
    const path = "/api/v5/trade/amend-algos";
    const bodyStr = JSON.stringify({
      algoId: params.algoOrderId,
      instId: params.instrumentId,
      newSlTriggerPx: params.newStopPrice,
      newSlTriggerPxType: "mark"
    });
    const nowMs = this.clock.nowMs();

    if (creds && creds.apiKey) {
      const headers = buildOkxHeaders({
        method: "POST",
        path,
        body: bodyStr,
        credentials: creds,
        timestampIso: new Date(nowMs).toISOString(),
        isDemo: this.isDemo
      });

      const res = await this.fetchFn(`https://www.okx.com${path}`, {
        method: "POST",
        headers,
        body: bodyStr
      });

      if (!res.ok) {
        throw new Error(`Failed to amend algo order: ${await res.text()}`);
      }
    }

    // Update local open position stop price
    for (const [id, pos] of this.localPositions.entries()) {
      if (pos.instrumentId === params.instrumentId && pos.status === "OPEN") {
        const updated = {
          ...pos,
          protectiveStopPrice: params.newStopPrice
        };
        this.localPositions.set(id, updated);
        if (this.accountRepo) {
          this.accountRepo.savePosition(updated);
        }
      }
    }

    return { ok: true, algoOrderId: params.algoOrderId, newStopPrice: params.newStopPrice };
  }

  public async reconcilePositions(): Promise<ReconciliationResult> {
    const nowMs = this.clock.nowMs();
    const openPositions = this.getOpenPositions();
    const driftDetails: string[] = [];
    const driftPositions: PaperPositionRecord[] = [];
    let exchangePositionsCount = openPositions.length;

    const creds = this.getCredentials();
    if (creds && creds.apiKey) {
      // 1. Query OKX positions
      const posPath = "/api/v5/account/positions";
      const posHeaders = buildOkxHeaders({
        method: "GET",
        path: posPath,
        credentials: creds,
        timestampIso: new Date(nowMs).toISOString(),
        isDemo: this.isDemo
      });

      const posRes = await this.fetchFn(`https://www.okx.com${posPath}`, {
        method: "GET",
        headers: posHeaders
      });

      if (!posRes.ok) {
        throw new Error(`OKX reconciliation failed to query positions (${posRes.status})`);
      }

      const posData = (await posRes.json()) as {
        code?: string;
        msg?: string;
        data?: Array<{
          instId?: string;
          pos?: string;
          posSide?: string;
          avgPx?: string;
          markPx?: string;
          upl?: string;
        }>;
      };

      if (posData.code && posData.code !== "0") {
        throw new Error(`OKX reconciliation query positions rejected: ${posData.msg}`);
      }

      // Filter active exchange positions (non-zero pos)
      const rawExchangePositions = posData.data ?? [];
      const activeExchangePositions = rawExchangePositions.filter((p) => {
        if (!p.pos) return false;
        try {
          return !ScaledDecimal.fromString(p.pos).isZero();
        } catch {
          return p.pos !== "0";
        }
      });

      exchangePositionsCount = activeExchangePositions.length;

      // Update local position mark-to-market unrealized PnL from exchange data
      for (const exPos of activeExchangePositions) {
        const instId = exPos.instId ?? "unknown";
        const matchingLocal = openPositions.find((p) => p.instrumentId === instId);
        if (matchingLocal) {
          let updatedUpl: ScaledDecimal | null = null;
          if (exPos.upl !== undefined && exPos.upl !== null && exPos.upl.trim() !== "") {
            try {
              updatedUpl = ScaledDecimal.fromString(exPos.upl);
            } catch {
              // Ignore invalid decimal
            }
          } else if (
            exPos.markPx !== undefined &&
            exPos.markPx !== null &&
            exPos.markPx.trim() !== ""
          ) {
            try {
              const markPx = ScaledDecimal.fromString(exPos.markPx);
              const entryPx = ScaledDecimal.fromString(matchingLocal.entryPrice);
              const contracts = ScaledDecimal.fromString(matchingLocal.contracts);
              const spec = defaultInstrumentSpec(matchingLocal.instrumentId);
              updatedUpl =
                matchingLocal.side === "long"
                  ? contracts.mul(spec.contractValue).mul(markPx.sub(entryPx))
                  : contracts.mul(spec.contractValue).mul(entryPx.sub(markPx));
            } catch {
              // Ignore invalid decimal
            }
          }

          if (updatedUpl !== null) {
            const updated: PaperPositionRecord = {
              ...matchingLocal,
              unrealizedPnlUsdt: updatedUpl.toFixed(8)
            };
            this.localPositions.set(matchingLocal.positionId, updated);
            if (this.accountRepo) {
              this.accountRepo.savePosition(updated);
            }
          }
        }
      }

      // 2. Query OKX pending conditional algo orders (protective stops)
      const algoPath = "/api/v5/trade/orders-algo-pending?ordType=conditional";
      const algoHeaders = buildOkxHeaders({
        method: "GET",
        path: algoPath,
        credentials: creds,
        timestampIso: new Date(nowMs).toISOString(),
        isDemo: this.isDemo
      });

      const algoRes = await this.fetchFn(`https://www.okx.com${algoPath}`, {
        method: "GET",
        headers: algoHeaders
      });

      if (!algoRes.ok) {
        throw new Error(`OKX reconciliation failed to query algo orders (${algoRes.status})`);
      }

      const algoData = (await algoRes.json()) as {
        code?: string;
        msg?: string;
        data?: Array<{
          algoId?: string;
          instId?: string;
          slTriggerPx?: string;
          state?: string;
        }>;
      };

      if (algoData.code && algoData.code !== "0") {
        throw new Error(`OKX reconciliation query algos rejected: ${algoData.msg}`);
      }

      const activeAlgos = algoData.data ?? [];

      // 3. Verify counts match
      if (activeExchangePositions.length !== openPositions.length) {
        driftDetails.push(
          `Position count mismatch: exchange has ${activeExchangePositions.length}, local has ${openPositions.length}`
        );
      }

      // 4. Verify each exchange position has a corresponding local position and an attached protective stop
      for (const exPos of activeExchangePositions) {
        const instId = exPos.instId ?? "unknown";
        const matchingLocal = openPositions.find((p) => p.instrumentId === instId);
        if (!matchingLocal) {
          driftDetails.push(
            `Exchange position on ${instId} (pos: ${exPos.pos}) not tracked locally`
          );
        }

        // Check attached protective stop on OKX
        const matchingAlgo = activeAlgos.find((a) => a.instId === instId);
        if (!matchingAlgo) {
          driftDetails.push(
            `Exchange position on ${instId} has no active protective stop algo order on OKX`
          );
        }
      }

      // 5. Verify each local position exists on exchange
      for (const locPos of openPositions) {
        const matchingEx = activeExchangePositions.find((p) => p.instId === locPos.instrumentId);
        if (!matchingEx) {
          driftDetails.push(
            `Local position ${locPos.positionId} (${locPos.instrumentId}) missing on exchange`
          );
          driftPositions.push(locPos);
        }
      }
    }

    // Verify all open positions have valid positive protective stops
    for (const pos of openPositions) {
      let valid = false;
      try {
        const stopPx = ScaledDecimal.fromString(pos.protectiveStopPrice);
        valid = stopPx.isPositive();
      } catch {
        valid = false;
      }

      if (!valid) {
        driftDetails.push(
          `Position ${pos.positionId} (${pos.instrumentId}) missing protective stop. Placing replacement or auto-flattening.`
        );
        if (!driftPositions.includes(pos)) {
          driftPositions.push(pos);
        }
      }
    }

    // ADR-0006: If attached stop missing during reconciliation, fire CRITICAL alert & emergency flatten
    if (driftDetails.length > 0) {
      if (this.notificationChannel) {
        await this.notificationChannel.send({
          severity: "CRITICAL",
          title: "PROTECTIVE STOP DRIFT DETECTED (ADR-0006)",
          body: `Found ${driftDetails.length} positions without active protective stops or exchange drift: ${driftDetails.join("; ")}`,
          dedupKey: `reconciliation-drift-${nowMs}`
        });
      }
      await this.flattenAllPositions("Reconciliation drift detected");
    }

    return {
      asOfMs: nowMs,
      matched: driftDetails.length === 0,
      localPositionsCount: openPositions.length,
      exchangePositionsCount,
      driftDetails
    };
  }

  public async flattenAllPositions(reason: string): Promise<readonly PaperPositionRecord[]> {
    const creds = this.getCredentials();
    const nowMs = this.clock.nowMs();

    if (creds && creds.apiKey) {
      // 1. Send cancel-all-after with timeOut: "0" to cancel resting orders on OKX
      const cancelPath = "/api/v5/trade/cancel-all-after";
      const cancelBody = JSON.stringify({ timeOut: "0" });
      const cancelHeaders = buildOkxHeaders({
        method: "POST",
        path: cancelPath,
        body: cancelBody,
        credentials: creds,
        timestampIso: new Date(nowMs).toISOString(),
        isDemo: this.isDemo
      });

      try {
        await this.fetchFn(`https://www.okx.com${cancelPath}`, {
          method: "POST",
          headers: cancelHeaders,
          body: cancelBody
        });
      } catch {
        // Continue to market reduceOnly orders
      }

      // 2. Submit market reduceOnly orders for all open positions
      for (const pos of this.localPositions.values()) {
        if (pos.status === "OPEN") {
          const flatClOrdId =
            `kflat${nowMs.toString(36)}${sha256Hex(pos.positionId).slice(0, 10)}`.slice(0, 32);
          const flatBody = JSON.stringify({
            instId: pos.instrumentId,
            tdMode: "isolated",
            side: pos.side === "long" ? "sell" : "buy",
            ordType: "market",
            sz: pos.contracts,
            reduceOnly: true,
            clOrdId: flatClOrdId
          });

          const flatHeaders = buildOkxHeaders({
            method: "POST",
            path: "/api/v5/trade/order",
            body: flatBody,
            credentials: creds,
            timestampIso: new Date(nowMs).toISOString(),
            isDemo: this.isDemo
          });

          try {
            await this.fetchFn("https://www.okx.com/api/v5/trade/order", {
              method: "POST",
              headers: flatHeaders,
              body: flatBody
            });
          } catch {
            // Continued
          }
        }
      }
    }

    const closed: PaperPositionRecord[] = [];

    for (const [id, pos] of this.localPositions.entries()) {
      if (pos.status === "OPEN") {
        let exitPriceDec = ScaledDecimal.fromString(pos.entryPrice);
        if (this.marketDataRepo) {
          try {
            const bars = this.marketDataRepo.getConfirmedBarsAsOf({
              instrumentId: pos.instrumentId,
              timeframe: "1H",
              asOfMs: nowMs,
              limit: 1
            });
            if (bars && bars.length > 0 && bars[0]) {
              exitPriceDec = ScaledDecimal.fromString(bars[0].close);
            }
          } catch {
            // fallback to entryPrice
          }
        }

        const entryPriceDec = ScaledDecimal.fromString(pos.entryPrice);
        const contractsDec = ScaledDecimal.fromString(pos.contracts);
        const spec = defaultInstrumentSpec(pos.instrumentId);
        const grossPnl =
          pos.side === "long"
            ? contractsDec.mul(spec.contractValue).mul(exitPriceDec.sub(entryPriceDec))
            : contractsDec.mul(spec.contractValue).mul(entryPriceDec.sub(exitPriceDec));

        const exitNotional = contractsDec.mul(spec.contractValue).mul(exitPriceDec);
        const exitFee = exitNotional.mul(ScaledDecimal.fromString("0.0006"));

        if (this.ledgerRepo) {
          const txGroup = `close-${pos.positionId}-${nowMs}`;
          if (grossPnl.isPositive()) {
            this.ledgerRepo.recordJournal({
              txGroupId: txGroup,
              ts: nowMs,
              strategyId: pos.strategyId,
              instrumentId: pos.instrumentId,
              debitAccount: "cash:usdt",
              creditAccount: "realized_pnl:usdt",
              amountUsdt: grossPnl.toFixed(8),
              description: `Gross profit on ${pos.positionId} (${reason})`
            });
          } else if (grossPnl.lt(ScaledDecimal.zero())) {
            this.ledgerRepo.recordJournal({
              txGroupId: txGroup,
              ts: nowMs,
              strategyId: pos.strategyId,
              instrumentId: pos.instrumentId,
              debitAccount: "realized_pnl:usdt",
              creditAccount: "cash:usdt",
              amountUsdt: grossPnl.abs().toFixed(8),
              description: `Gross loss on ${pos.positionId} (${reason})`
            });
          }

          if (exitFee.isPositive()) {
            this.ledgerRepo.recordJournal({
              txGroupId: txGroup,
              ts: nowMs,
              strategyId: pos.strategyId,
              instrumentId: pos.instrumentId,
              debitAccount: "fees_expense:usdt",
              creditAccount: "cash:usdt",
              amountUsdt: exitFee.toFixed(8),
              description: `Exit execution fee on ${pos.positionId}`
            });
          }
        }

        const prevFees = ScaledDecimal.fromString(pos.feesPaidUsdt);
        const totalFees = prevFees.add(exitFee);

        const closedPos: PaperPositionRecord = {
          ...pos,
          status: "CLOSED",
          closedAtMs: nowMs,
          exitPrice: exitPriceDec.toFixed(8),
          realizedPnlUsdt: grossPnl.toFixed(8),
          unrealizedPnlUsdt: "0.00000000",
          feesPaidUsdt: totalFees.toFixed(8),
          exitReason: reason
        };
        this.localPositions.set(id, closedPos);
        if (this.accountRepo) {
          this.accountRepo.savePosition(closedPos);
        }
        closed.push(closedPos);

        // Record flatten market order
        const flatOrder: PaperOrderRecord = {
          orderId: `flat_${pos.positionId}_${nowMs}`,
          positionId: pos.positionId,
          proposalId: `flat_${nowMs}`,
          strategyId: pos.strategyId,
          instrumentId: pos.instrumentId,
          side: pos.side === "long" ? "short" : "long",
          orderRole: "FLATTEN",
          contracts: pos.contracts,
          fillPrice: exitPriceDec.toFixed(8),
          protectiveStopPrice: "0",
          feeUsdt: exitFee.toFixed(8),
          status: "FILLED",
          createdAtMs: nowMs
        };
        this.localOrders.push(flatOrder);
        if (this.accountRepo) {
          this.accountRepo.saveOrder(flatOrder);
        }
      }
    }

    return closed;
  }

  public executeConfirmedBarTick(params: {
    readonly bar: ConfirmedBar;
    readonly strategy?: unknown;
    readonly spec?: unknown;
  }): PaperTickResult {
    const nowMs = this.clock.nowMs();
    return {
      asOfMs: nowMs,
      barEvaluated: params.bar,
      positionsClosed: [],
      positionsOpened: [],
      vetoedProposals: [],
      trialBalance: {
        totalDebitsUsdt: "0.00",
        totalCreditsUsdt: "0.00",
        isBalanced: true,
        cashBalanceUsdt: "0.00",
        realizedPnlUsdt: "0.00",
        feesExpenseUsdt: "0.00",
        fundingPnlUsdt: "0.00",
        netEquityUsdt: "0.00",
        entryCount: 0
      }
    };
  }
}
