import { createHmac } from "node:crypto";
import {
  MANUAL_EXECUTION_STRATEGY_ID,
  createDefaultConfig,
  getExchangeInstrumentSpec,
  sha256Hex,
  ScaledDecimal,
  isRealMoneyExecutionMode,
  type Clock,
  type CircuitBreakerRecord,
  type ConfirmedBar,
  type DmsStatus,
  type ExchangeBroker,
  type ExchangeOrderInput,
  type ExchangeOrderResult,
  type ExecutionMode,
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
  /** Static flag, or a getter re-evaluated per request so the venue tracks the Execution Mode. */
  readonly isDemo?: boolean | (() => boolean) | undefined;
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

/**
 * Only real-money Execution Modes reach the live OKX account; every other mode signs requests
 * for the demo venue (audit-3 H5).
 */
export function okxDemoVenueFor(mode: ExecutionMode): boolean {
  return !isRealMoneyExecutionMode(mode);
}

export class OkxBroker implements ExchangeBroker {
  private readonly clock: Clock;
  private readonly getRiskConfig: () => RiskConfig;
  private readonly getCredentials: () => OkxCredentials | null;
  private readonly isDemoVenue: () => boolean;
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
    const isDemo = options.isDemo ?? true;
    this.isDemoVenue = typeof isDemo === "function" ? isDemo : () => isDemo;
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

  /** USDT equity of the venue account for the current Execution Mode; throws if it cannot be read. */
  public async getVenueEquityUsdt(): Promise<ScaledDecimal> {
    const creds = this.getCredentials();
    if (!creds || !creds.apiKey) {
      throw new Error("OKX credentials are not configured; cannot read the venue balance");
    }
    const path = "/api/v5/account/balance?ccy=USDT";
    const res = await this.fetchFn(`https://www.okx.com${path}`, {
      method: "GET",
      headers: buildOkxHeaders({
        method: "GET",
        path,
        credentials: creds,
        timestampIso: new Date(this.clock.nowMs()).toISOString(),
        isDemo: this.isDemoVenue()
      })
    });
    if (!res.ok) {
      throw new Error(`OKX balance query failed with HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      code?: string;
      msg?: string;
      data?: Array<{ details?: Array<{ ccy?: string; eq?: string }> }>;
    };
    const usdt = payload.data?.[0]?.details?.find((d) => d.ccy === "USDT");
    if (payload.code !== "0" || !usdt?.eq) {
      throw new Error(
        `OKX balance query returned no USDT equity (code ${payload.code ?? "unknown"}: ${payload.msg ?? ""})`
      );
    }
    return ScaledDecimal.fromString(usdt.eq);
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
              const spec = getExchangeInstrumentSpec(pos.instrumentId);
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
    const creds = this.getCredentials();
    const hasCreds = Boolean(creds && creds.apiKey);
    const last = this.dmsLastHeartbeatAtMs;
    const timeoutSeconds = 60;
    const nextHeartbeatDueMs = last !== null ? last + 15_000 : null;
    const isExpired = last !== null && now - last > timeoutSeconds * 1000;

    return {
      enabled: true,
      timeoutSeconds,
      lastHeartbeatAtMs: last,
      nextHeartbeatDueMs,
      healthy: hasCreds && last !== null && !isExpired
    };
  }

  public async sendDmsHeartbeat(): Promise<{
    ok: boolean;
    countdownSeconds: number;
    status?: "ok" | "not_configured" | "failed";
  }> {
    const creds = this.getCredentials();
    const nowMs = this.clock.nowMs();

    if (!creds || !creds.apiKey) {
      return { ok: false, countdownSeconds: 0, status: "not_configured" };
    }

    const path = "/api/v5/trade/cancel-all-after";
    const body = JSON.stringify({ timeOut: "60" });

    if (creds && creds.apiKey) {
      const headers = buildOkxHeaders({
        method: "POST",
        path,
        body,
        credentials: creds,
        timestampIso: new Date(this.clock.nowMs()).toISOString(),
        isDemo: this.isDemoVenue()
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
    return { ok: true, countdownSeconds: 60, status: "ok" };
  }

  public async submitOrder(input: ExchangeOrderInput): Promise<ExchangeOrderResult> {
    // Never simulate an exchange fill (audit-3 H7): no credentials means no order
    const creds = this.getCredentials();
    if (!creds || !creds.apiKey) {
      throw new Error("OKX credentials are not configured; refusing to submit exchange order");
    }
    // Paper-only instruments never reach the venue
    getExchangeInstrumentSpec(input.instrumentId);

    if (input.reduceOnly) {
      return this.submitReduceOnlyClose(input);
    }

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

    // OKX attachAlgoOrds format per ADR-0006 with TP support (C7, M-E)
    // Confirmed OKX V5 fields: slTriggerPx, slOrdPx, slTriggerPxType, tpTriggerPx, tpOrdPx, tpTriggerPxType
    // Unverified fields (reduceOnly, closeFraction inside attachAlgoOrds) omitted per OKX V5 spec
    const attachAlgoOrd: Record<string, unknown> = {
      attachAlgoClOrdId: algoClOrdId,
      slTriggerPx: input.protectiveStopPrice,
      slOrdPx: "-1", // market order execution on trigger
      slTriggerPxType: "mark" // mark price to protect against wicks/manipulation
    };

    if (tpPx !== null && input.takeProfitPrice) {
      attachAlgoOrd["tpTriggerPx"] = input.takeProfitPrice;
      attachAlgoOrd["tpOrdPx"] = "-1";
      attachAlgoOrd["tpTriggerPxType"] = "mark";
    }

    const attachAlgoOrds = [attachAlgoOrd];

    const effectiveTdMode = input.tdMode ?? "isolated";
    const orderPayload: Record<string, unknown> = {
      instId: input.instrumentId,
      tdMode: effectiveTdMode,
      side: input.side === "long" ? "buy" : "sell",
      ordType: "market",
      sz: String(input.sizeLots),
      clOrdId,
      reduceOnly: input.reduceOnly,
      attachAlgoOrds
    };
    if (input.posSide && input.posSide !== "net") {
      orderPayload["posSide"] = input.posSide;
    }

    const path = "/api/v5/trade/order";
    const bodyStr = JSON.stringify(orderPayload);

    let orderId = `ord${clOrdId}`;
    let algoOrderId = `algo${algoClOrdId}`;
    let fillPriceStr = input.entryPrice;
    let actualContracts = ScaledDecimal.fromString(String(input.sizeLots));
    let feeUsdtOverride: ScaledDecimal | null = null;
    let isFillConfirmed = false;

    if (creds && creds.apiKey) {
      const headers = buildOkxHeaders({
        method: "POST",
        path,
        body: bodyStr,
        credentials: creds,
        timestampIso: new Date(this.clock.nowMs()).toISOString(),
        isDemo: this.isDemoVenue()
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

      // 1. Query true execution fill details (price, executed quantity, fee) from OKX execution report
      const orderQueryPath = `/api/v5/trade/order?instId=${encodeURIComponent(input.instrumentId)}&ordId=${encodeURIComponent(orderId)}`;
      const orderQueryHeaders = buildOkxHeaders({
        method: "GET",
        path: orderQueryPath,
        credentials: creds,
        timestampIso: new Date(this.clock.nowMs()).toISOString(),
        isDemo: this.isDemoVenue()
      });

      try {
        const orderRes = await this.fetchFn(`https://www.okx.com${orderQueryPath}`, {
          method: "GET",
          headers: orderQueryHeaders
        });

        if (orderRes.ok) {
          const orderData = (await orderRes.json()) as {
            code?: string;
            data?: Array<{
              avgPx?: string;
              accFillSz?: string;
              fillPx?: string;
              fee?: string;
              feeCcy?: string;
              state?: string;
            }>;
          };
          const fillItem = orderData.data?.[0];
          if (fillItem) {
            const hasAvgPx = Boolean(
              fillItem.avgPx && fillItem.avgPx.trim() !== "" && fillItem.avgPx !== "0"
            );
            const hasFillPx = Boolean(
              fillItem.fillPx && fillItem.fillPx.trim() !== "" && fillItem.fillPx !== "0"
            );

            if (hasAvgPx && fillItem.avgPx) {
              fillPriceStr = fillItem.avgPx;
            } else if (hasFillPx && fillItem.fillPx) {
              fillPriceStr = fillItem.fillPx;
            }

            if (fillItem.state === "filled" && (hasAvgPx || hasFillPx)) {
              isFillConfirmed = true;
            }

            if (fillItem.accFillSz && fillItem.accFillSz.trim() !== "") {
              try {
                const filledContracts = ScaledDecimal.fromString(fillItem.accFillSz.trim());
                if (filledContracts.isPositive()) {
                  actualContracts = filledContracts;
                }
              } catch {
                // Malformed accFillSz; keep the requested size and leave the fill unconfirmed
                isFillConfirmed = false;
              }
            }
            if (fillItem.fee && fillItem.fee.trim() !== "") {
              feeUsdtOverride = ScaledDecimal.fromString(fillItem.fee).abs();
            }
          }
        }
      } catch {
        // Query error; leave isFillConfirmed = false
      }

      // C3d: Fill-query failure on submit alerts CRITICAL, emergency flattens, throws
      if (!isFillConfirmed) {
        if (this.notificationChannel) {
          await this.notificationChannel.send({
            severity: "CRITICAL",
            title: "CRITICAL: UNCONFIRMED EXECUTION FILL",
            body: `Order ${orderId} was placed on exchange but fill details could not be confirmed on OKX. Executing emergency flatten.`,
            dedupKey: `unconfirmed-fill-${orderId}`
          });
        }
        await this.flattenAllPositions(`Unconfirmed fill for order ${orderId}`);
        throw new Error(
          `Order ${orderId} fill details could not be confirmed on OKX. Emergency position flatten executed (ADR-0018).`
        );
      }

      // 2. Query OKX to confirm attached protective stop algo order (conditional and oco)
      let confirmedAlgoId: string | null = null;
      for (const ordType of ["conditional", "oco"]) {
        if (confirmedAlgoId) break;
        const algoPath = `/api/v5/trade/orders-algo-pending?instId=${encodeURIComponent(input.instrumentId)}&ordType=${ordType}`;
        const algoHeaders = buildOkxHeaders({
          method: "GET",
          path: algoPath,
          credentials: creds,
          timestampIso: new Date(this.clock.nowMs()).toISOString(),
          isDemo: this.isDemoVenue()
        });

        try {
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
                attachAlgoClOrdId?: string;
                state?: string;
              }>;
            };
            if (algoData.code === "0" && Array.isArray(algoData.data)) {
              // C3a: match ONLY by ID equality (delete single-pending shortcut)
              const matches = algoData.data.filter(
                (a) =>
                  (a.algoClOrdId && (a.algoClOrdId === algoClOrdId || a.algoClOrdId === clOrdId)) ||
                  (a.attachAlgoClOrdId && a.attachAlgoClOrdId === algoClOrdId) ||
                  Boolean(algoOrderId && a.algoId && a.algoId === algoOrderId)
              );
              if (matches.length > 0 && matches[0]?.algoId) {
                confirmedAlgoId = matches[0].algoId;
              }
            }
          }
        } catch {
          // Query error
        }
      }

      if (!confirmedAlgoId) {
        if (this.notificationChannel) {
          await this.notificationChannel.send({
            severity: "CRITICAL",
            title: "CRITICAL: UNCONFIRMED PROTECTIVE STOP",
            body: `Order ${orderId} was placed on exchange but protective stop algo order (${algoClOrdId}) could not be confirmed on OKX. Executing emergency flatten.`,
            dedupKey: `unconfirmed-stop-${orderId}`
          });
        }

        // Emergency flatten on exchange
        await this.flattenAllPositions(
          `Unconfirmed protective stop algo order for order ${orderId}`
        );

        throw new Error(
          `Protective stop algo order (${algoClOrdId}) could not be confirmed on OKX. Emergency position flatten executed (ADR-0006).`
        );
      }

      algoOrderId = confirmedAlgoId;
    }

    const fillPxDec = ScaledDecimal.fromString(fillPriceStr);
    const contractsDec = actualContracts;
    const spec = getExchangeInstrumentSpec(input.instrumentId);

    const orderResult: ExchangeOrderResult = {
      orderId,
      clOrdId,
      algoOrderId,
      instrumentId: input.instrumentId,
      side: input.side,
      fillPrice: fillPriceStr,
      sizeLots: actualContracts.toString(),
      protectiveStopPrice: input.protectiveStopPrice,
      status: isFillConfirmed ? "FILLED" : "SUBMITTED",
      submittedAtMs: nowMs
    };

    // Update local state
    const posId = `pos_${clOrdId}`;
    const effectiveStrategyId = input.strategyId ?? MANUAL_EXECUTION_STRATEGY_ID;
    const initialRisk =
      input.initialRiskUsdt ??
      (input.side === "long" ? fillPxDec.sub(stopPx) : stopPx.sub(fillPxDec))
        .mul(contractsDec)
        .mul(spec.contractValue)
        .toFixed(2);

    const notional = contractsDec.mul(spec.contractValue).mul(fillPxDec);
    const feeRate = ScaledDecimal.fromString("0.0006");
    const entryFee = feeUsdtOverride ?? notional.mul(feeRate);

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
      contracts: actualContracts.toString(),
      entryPrice: fillPriceStr,
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
      contracts: actualContracts.toString(),
      fillPrice: fillPriceStr,
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
   * Reduce-only orders fully close the matching open position (audit-3 H6). They never open a
   * position or attach a stop; partial reduction is refused because resizing the resting stop
   * is not modelled.
   */
  private async submitReduceOnlyClose(input: ExchangeOrderInput): Promise<ExchangeOrderResult> {
    const closingSide = input.side === "long" ? "short" : "long";
    const pos = Array.from(this.localPositions.values()).find(
      (p) => p.status === "OPEN" && p.instrumentId === input.instrumentId && p.side === closingSide
    );
    if (!pos) {
      throw new Error(
        `Reduce-only ${input.side} rejected: no open ${closingSide} position on ${input.instrumentId}`
      );
    }
    if (
      !ScaledDecimal.fromString(String(input.sizeLots)).equals(
        ScaledDecimal.fromString(pos.contracts)
      )
    ) {
      throw new Error(
        `Reduce-only orders must close the full position (${pos.contracts} lots); partial reduction is not supported`
      );
    }

    const [closed] = await this.closePositionsWhere(
      "Reduce-only close",
      (p) => p.positionId === pos.positionId,
      false
    );
    if (!closed || closed.closedAtMs === null || closed.exitPrice === null) {
      throw new Error(
        `Reduce-only close of ${pos.positionId} could not be confirmed on OKX; position remains OPEN with its protective stop`
      );
    }

    const orderId = `flat_${pos.positionId}_${closed.closedAtMs}`;
    return {
      orderId,
      clOrdId: orderId,
      algoOrderId: "",
      instrumentId: input.instrumentId,
      side: input.side,
      fillPrice: closed.exitPrice,
      sizeLots: pos.contracts,
      protectiveStopPrice: pos.protectiveStopPrice,
      status: "FILLED",
      submittedAtMs: closed.closedAtMs
    };
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

    if (creds && creds.apiKey) {
      const headers = buildOkxHeaders({
        method: "POST",
        path,
        body: bodyStr,
        credentials: creds,
        timestampIso: new Date(this.clock.nowMs()).toISOString(),
        isDemo: this.isDemoVenue()
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
        timestampIso: new Date(this.clock.nowMs()).toISOString(),
        isDemo: this.isDemoVenue()
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
              const spec = getExchangeInstrumentSpec(matchingLocal.instrumentId);
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

      // 2. Query OKX pending conditional and OCO algo orders (protective stops & take-profits)
      const activeAlgos: Array<{
        algoId?: string;
        instId?: string;
        slTriggerPx?: string;
        state?: string;
      }> = [];

      for (const ordType of ["conditional", "oco"]) {
        const algoPath = `/api/v5/trade/orders-algo-pending?ordType=${ordType}`;
        const algoHeaders = buildOkxHeaders({
          method: "GET",
          path: algoPath,
          credentials: creds,
          timestampIso: new Date(this.clock.nowMs()).toISOString(),
          isDemo: this.isDemoVenue()
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

        if (Array.isArray(algoData.data)) {
          activeAlgos.push(...algoData.data);
        }
      }

      // 3. Verify each local position exists on exchange (or was closed by confirmed stop/TP fill)
      for (const locPos of openPositions) {
        const matchingEx = activeExchangePositions.find((p) => p.instId === locPos.instrumentId);
        if (!matchingEx) {
          // C3b: Check fill/order history on OKX before declaring drift!
          let resolvedByHistory = false;
          try {
            const fillsPath = `/api/v5/trade/fills?instType=SWAP&instId=${encodeURIComponent(locPos.instrumentId)}`;
            const fillsHeaders = buildOkxHeaders({
              method: "GET",
              path: fillsPath,
              credentials: creds,
              timestampIso: new Date(this.clock.nowMs()).toISOString(),
              isDemo: this.isDemoVenue()
            });
            const fillsRes = await this.fetchFn(`https://www.okx.com${fillsPath}`, {
              method: "GET",
              headers: fillsHeaders
            });
            if (fillsRes.ok) {
              const fillsData = (await fillsRes.json()) as {
                code?: string;
                data?: Array<{
                  instId?: string;
                  side?: string;
                  posSide?: string;
                  fillPx?: string;
                  avgPx?: string;
                  fee?: string;
                  sz?: string;
                  fillTime?: string;
                  ts?: string;
                  uTime?: string;
                }>;
              };
              if (fillsData.code === "0" && Array.isArray(fillsData.data)) {
                const closeSide = locPos.side === "long" ? "sell" : "buy";
                const matchingFill = fillsData.data.find((f) => {
                  const fTs = Number(f.fillTime || f.uTime || f.ts || 0);
                  const isOpposite =
                    f.side === closeSide &&
                    (!f.posSide || f.posSide === "net" || f.posSide === locPos.side);
                  return f.instId === locPos.instrumentId && isOpposite && fTs >= locPos.openedAtMs;
                });
                if (matchingFill && (matchingFill.fillPx || matchingFill.avgPx)) {
                  resolvedByHistory = true;
                  const exitPxStr = matchingFill.fillPx || matchingFill.avgPx || locPos.entryPrice;
                  const exitPxDec = ScaledDecimal.fromString(exitPxStr);
                  const entryPxDec = ScaledDecimal.fromString(locPos.entryPrice);
                  const contractsDec = ScaledDecimal.fromString(locPos.contracts);
                  const spec = getExchangeInstrumentSpec(locPos.instrumentId);
                  const exitFeeDec = matchingFill.fee
                    ? ScaledDecimal.fromString(matchingFill.fee).abs()
                    : ScaledDecimal.zero();

                  const grossPnl =
                    locPos.side === "long"
                      ? contractsDec.mul(spec.contractValue).mul(exitPxDec.sub(entryPxDec))
                      : contractsDec.mul(spec.contractValue).mul(entryPxDec.sub(exitPxDec));

                  const fillTimeMs = Number(matchingFill.fillTime || matchingFill.uTime || nowMs);

                  // Post real PnL to ledger
                  if (this.ledgerRepo) {
                    const txGroup = `close-${locPos.positionId}-${fillTimeMs}`;
                    if (grossPnl.isPositive()) {
                      this.ledgerRepo.recordJournal({
                        txGroupId: txGroup,
                        ts: fillTimeMs,
                        strategyId: locPos.strategyId,
                        instrumentId: locPos.instrumentId,
                        debitAccount: "cash:usdt",
                        creditAccount: "realized_pnl:usdt",
                        amountUsdt: grossPnl.toFixed(8),
                        description: `Realized profit on ${locPos.positionId} from exchange fill`
                      });
                    } else if (grossPnl.lt(ScaledDecimal.zero())) {
                      this.ledgerRepo.recordJournal({
                        txGroupId: txGroup,
                        ts: fillTimeMs,
                        strategyId: locPos.strategyId,
                        instrumentId: locPos.instrumentId,
                        debitAccount: "realized_pnl:usdt",
                        creditAccount: "cash:usdt",
                        amountUsdt: grossPnl.abs().toFixed(8),
                        description: `Realized loss on ${locPos.positionId} from exchange fill`
                      });
                    }

                    if (exitFeeDec.isPositive()) {
                      this.ledgerRepo.recordJournal({
                        txGroupId: txGroup,
                        ts: fillTimeMs,
                        strategyId: locPos.strategyId,
                        instrumentId: locPos.instrumentId,
                        debitAccount: "fees_expense:usdt",
                        creditAccount: "cash:usdt",
                        amountUsdt: exitFeeDec.toFixed(8),
                        description: `Exit execution fee on ${locPos.positionId}`
                      });
                    }
                  }

                  const prevFees = ScaledDecimal.fromString(locPos.feesPaidUsdt);
                  const updated: PaperPositionRecord = {
                    ...locPos,
                    status: "CLOSED",
                    closedAtMs: fillTimeMs,
                    exitPrice: exitPxStr,
                    exitReason: "exchange_stop_or_tp_fill",
                    realizedPnlUsdt: grossPnl.toFixed(8),
                    unrealizedPnlUsdt: "0.00000000",
                    feesPaidUsdt: prevFees.add(exitFeeDec).toFixed(8)
                  };
                  this.localPositions.set(locPos.positionId, updated);
                  if (this.accountRepo) {
                    this.accountRepo.savePosition(updated);
                  }
                }
              }
            }
          } catch {
            // Fill history query error
          }

          if (!resolvedByHistory) {
            driftDetails.push(
              `Local position ${locPos.positionId} (${locPos.instrumentId}) missing on exchange with no confirmed exit fill`
            );
            driftPositions.push(locPos);
          }
        }
      }

      const activeLocalPositions = this.getOpenPositions();

      // 4. Verify counts match remaining active positions
      if (activeExchangePositions.length !== activeLocalPositions.length) {
        driftDetails.push(
          `Position count mismatch: exchange has ${activeExchangePositions.length}, local has ${activeLocalPositions.length}`
        );
      }

      // 5. Verify each exchange position has a corresponding local position and an attached protective stop
      for (const exPos of activeExchangePositions) {
        const instId = exPos.instId ?? "unknown";
        let isExLong = true;
        try {
          const exPosQty = ScaledDecimal.fromString(exPos.pos ?? "0");
          isExLong = exPos.posSide === "long" || (exPos.posSide === "net" && exPosQty.isPositive());
        } catch {
          isExLong = exPos.posSide === "long";
        }

        const matchingLocal = activeLocalPositions.find(
          (p) => p.instrumentId === instId && (p.side === "long" ? isExLong : !isExLong)
        );
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

  /** Cancels resting stop/TP algos for one instrument; only call once its position is flat. */
  private async cancelProtectiveAlgos(instId: string, creds: OkxCredentials): Promise<void> {
    const cancelPayload: Array<{ algoId: string; instId: string }> = [];
    for (const ordType of ["conditional", "oco"]) {
      const queryPath = `/api/v5/trade/orders-algo-pending?instId=${encodeURIComponent(instId)}&ordType=${ordType}`;
      try {
        const res = await this.fetchFn(`https://www.okx.com${queryPath}`, {
          method: "GET",
          headers: buildOkxHeaders({
            method: "GET",
            path: queryPath,
            credentials: creds,
            timestampIso: new Date(this.clock.nowMs()).toISOString(),
            isDemo: this.isDemoVenue()
          })
        });
        if (res.ok) {
          const resJson = (await res.json()) as {
            code?: string;
            data?: Array<{ algoId?: string; instId?: string }>;
          };
          if (resJson.code === "0" && Array.isArray(resJson.data)) {
            for (const a of resJson.data) {
              if (a.algoId && a.instId === instId) {
                cancelPayload.push({ algoId: a.algoId, instId });
              }
            }
          }
        }
      } catch {
        // An orphaned reduce-only stop on a flat instrument is harmless; reconciliation re-checks
      }
    }
    if (cancelPayload.length === 0) {
      return;
    }

    const cancelPath = "/api/v5/trade/cancel-algo-orders";
    const cancelBody = JSON.stringify(cancelPayload);
    try {
      await this.fetchFn(`https://www.okx.com${cancelPath}`, {
        method: "POST",
        headers: buildOkxHeaders({
          method: "POST",
          path: cancelPath,
          body: cancelBody,
          credentials: creds,
          timestampIso: new Date(this.clock.nowMs()).toISOString(),
          isDemo: this.isDemoVenue()
        }),
        body: cancelBody
      });
    } catch {
      // See above: leaving the algo resting is the safe failure mode
    }
  }

  public async flattenAllPositions(reason: string): Promise<readonly PaperPositionRecord[]> {
    return this.closePositionsWhere(reason, () => true, true);
  }

  /**
   * Market-closes the selected open positions with confirmed fills. `sweepForeign` also closes
   * untracked exchange positions and disarms the DMS once everything is flat (full flatten only).
   */
  private async closePositionsWhere(
    reason: string,
    include: (pos: PaperPositionRecord) => boolean,
    sweepForeign: boolean
  ): Promise<readonly PaperPositionRecord[]> {
    const creds = this.getCredentials();
    const nowMs = this.clock.nowMs();
    const failedPositionIds = new Set<string>();
    const confirmedFills = new Map<string, { exitPrice: string; fee: ScaledDecimal }>();

    let foreignFailures = 0;

    if (!creds || !creds.apiKey) {
      // Never fabricate exits (audit-3 H7): without exchange access nothing can be closed truthfully
      const stranded = Array.from(this.localPositions.values()).filter(
        (p) => p.status === "OPEN" && include(p)
      );
      if (stranded.length > 0) {
        throw new Error(
          `OKX credentials are not configured; cannot close ${stranded.length} open exchange position(s)`
        );
      }
      return [];
    }

    {
      // Protective stops stay resting until each position's close is confirmed (audit-3 C1):
      // they are cancelled per instrument after the fill, never up front.

      // 1. Query OKX account positions to detect untracked / foreign positions
      let exchangePositions: Array<{
        instId: string;
        pos: string;
        posSide?: string;
        mgnMode?: string;
      }> = [];
      try {
        const posPath = "/api/v5/account/positions";
        const posHeaders = buildOkxHeaders({
          method: "GET",
          path: posPath,
          credentials: creds,
          timestampIso: new Date(this.clock.nowMs()).toISOString(),
          isDemo: this.isDemoVenue()
        });
        const posRes = await this.fetchFn(`https://www.okx.com${posPath}`, {
          method: "GET",
          headers: posHeaders
        });
        if (posRes.ok) {
          const posData = (await posRes.json()) as {
            code?: string;
            msg?: string;
            data?: Array<{ instId?: string; pos?: string; posSide?: string; mgnMode?: string }>;
          };
          if (posData.code === "0" && Array.isArray(posData.data)) {
            exchangePositions = posData.data.filter(
              (p): p is { instId: string; pos: string; posSide?: string; mgnMode?: string } =>
                Boolean(p.instId && p.pos && p.pos !== "0")
            );
          } else if (this.notificationChannel) {
            await this.notificationChannel.send({
              severity: "CRITICAL",
              title: "EXCHANGE POSITIONS QUERY FAILED",
              body: `OKX positions query returned error during emergency flatten: code ${posData.code ?? "unknown"} - ${posData.msg ?? "unknown"}`,
              dedupKey: `flatten-pos-query-fail-${nowMs}`
            });
          }
        } else {
          const errText = await posRes.text();
          if (this.notificationChannel) {
            await this.notificationChannel.send({
              severity: "CRITICAL",
              title: "EXCHANGE POSITIONS QUERY FAILED",
              body: `HTTP ${posRes.status} querying OKX positions during emergency flatten: ${errText}`,
              dedupKey: `flatten-pos-query-fail-${nowMs}`
            });
          }
        }
      } catch (err) {
        if (this.notificationChannel) {
          await this.notificationChannel.send({
            severity: "CRITICAL",
            title: "EXCHANGE POSITIONS QUERY FAILED",
            body: `Exception querying OKX positions during emergency flatten: ${err instanceof Error ? err.message : String(err)}`,
            dedupKey: `flatten-pos-query-fail-${nowMs}`
          });
        }
      }

      // 2. Submit market reduceOnly orders for all open local positions
      for (const pos of this.localPositions.values()) {
        if (pos.status === "OPEN" && include(pos)) {
          const flatClOrdId =
            `kflat${nowMs.toString(36)}${sha256Hex(pos.positionId).slice(0, 10)}`.slice(0, 32);

          const matchingExPos = exchangePositions.find((ep) => ep.instId === pos.instrumentId);
          const flatTdMode = matchingExPos?.mgnMode ?? "isolated";
          const flatPosSide =
            matchingExPos?.posSide && matchingExPos.posSide !== "net"
              ? matchingExPos.posSide
              : undefined;

          const flatBodyObj: Record<string, unknown> = {
            instId: pos.instrumentId,
            tdMode: flatTdMode,
            side: pos.side === "long" ? "sell" : "buy",
            ordType: "market",
            sz: pos.contracts,
            reduceOnly: true,
            clOrdId: flatClOrdId
          };
          if (flatPosSide) {
            flatBodyObj["posSide"] = flatPosSide;
          }
          const flatBody = JSON.stringify(flatBodyObj);

          const flatHeaders = buildOkxHeaders({
            method: "POST",
            path: "/api/v5/trade/order",
            body: flatBody,
            credentials: creds,
            timestampIso: new Date(this.clock.nowMs()).toISOString(),
            isDemo: this.isDemoVenue()
          });

          let orderSuccess = false;
          let flatOrdId: string | null = null;
          let errMsg = "";
          try {
            const flatRes = await this.fetchFn("https://www.okx.com/api/v5/trade/order", {
              method: "POST",
              headers: flatHeaders,
              body: flatBody
            });

            if (flatRes.ok) {
              const resData = (await flatRes.json()) as {
                code?: string;
                msg?: string;
                data?: Array<{ ordId?: string; sCode?: string; sMsg?: string }>;
              };
              if (resData.code === "0") {
                const item = resData.data?.[0];
                if (!item || !item.sCode || item.sCode === "0") {
                  orderSuccess = true;
                  if (item?.ordId) {
                    flatOrdId = item.ordId;
                  }
                } else {
                  errMsg = `sCode ${item.sCode}: ${item.sMsg ?? "unknown sub-error"}`;
                }
              } else {
                errMsg = `code ${resData.code}: ${resData.msg ?? "unknown error"}`;
              }
            } else {
              const errText = await flatRes.text();
              errMsg = `HTTP ${flatRes.status}: ${errText}`;
            }
          } catch (err) {
            errMsg = err instanceof Error ? err.message : String(err);
          }

          let closeFillConfirmed = false;
          let realExitPxStr: string | null = null;
          let realExitFee: ScaledDecimal | null = null;

          // C3c: Query real fill details from OKX
          if (orderSuccess && flatOrdId) {
            try {
              const fillQueryPath = `/api/v5/trade/order?instId=${encodeURIComponent(pos.instrumentId)}&ordId=${encodeURIComponent(flatOrdId)}`;
              const fillQueryHeaders = buildOkxHeaders({
                method: "GET",
                path: fillQueryPath,
                credentials: creds,
                timestampIso: new Date(this.clock.nowMs()).toISOString(),
                isDemo: this.isDemoVenue()
              });
              const fillRes = await this.fetchFn(`https://www.okx.com${fillQueryPath}`, {
                method: "GET",
                headers: fillQueryHeaders
              });
              if (fillRes.ok) {
                const fillData = (await fillRes.json()) as {
                  code?: string;
                  data?: Array<{
                    avgPx?: string;
                    fillPx?: string;
                    fee?: string;
                    state?: string;
                  }>;
                };
                if (fillData.code === "0") {
                  const fItem = fillData.data?.[0];
                  if (fItem && fItem.state === "filled" && (fItem.avgPx || fItem.fillPx)) {
                    realExitPxStr = fItem.avgPx || fItem.fillPx || null;
                    if (fItem.fee && fItem.fee.trim() !== "") {
                      realExitFee = ScaledDecimal.fromString(fItem.fee).abs();
                    }
                    closeFillConfirmed = true;
                  }
                }
              }
            } catch {
              // Fill query failed
            }
          }

          if (!orderSuccess || !closeFillConfirmed || !realExitPxStr) {
            failedPositionIds.add(pos.positionId);
            if (this.notificationChannel) {
              await this.notificationChannel.send({
                severity: "CRITICAL",
                title: "EMERGENCY FLATTEN FAILED FOR POSITION",
                body: `Failed to confirm execution fill for position ${pos.positionId} (${pos.instrumentId}) on OKX: ${errMsg || "unconfirmed fill"}. Position remains OPEN; no fictional PnL posted.`,
                dedupKey: `flatten-fail-${pos.positionId}-${nowMs}`
              });
            }
          } else {
            confirmedFills.set(pos.positionId, {
              exitPrice: realExitPxStr,
              fee: realExitFee ?? ScaledDecimal.zero()
            });
            // Algos are cancelled per instrument, so wait until no other open position on it
            // still relies on its stop; an orphaned reduce-only stop is the safe leftover
            const instrumentStillProtecting = Array.from(this.localPositions.values()).some(
              (other) =>
                other.status === "OPEN" &&
                other.instrumentId === pos.instrumentId &&
                !confirmedFills.has(other.positionId)
            );
            if (!instrumentStillProtecting) {
              await this.cancelProtectiveAlgos(pos.instrumentId, creds);
            }
          }
        }
      }

      // 3. Dispose of untracked foreign exchange positions not present in local state
      for (const exPos of sweepForeign ? exchangePositions : []) {
        // OKX signs `pos` only in net mode; in long/short mode it is unsigned and posSide carries the side
        const reportedQty = ScaledDecimal.fromString(exPos.pos);
        const hedgeSide =
          exPos.posSide === "long" || exPos.posSide === "short" ? exPos.posSide : null;
        const exPosQty =
          hedgeSide === "short"
            ? ScaledDecimal.zero().sub(reportedQty.abs())
            : hedgeSide === "long"
              ? reportedQty.abs()
              : reportedQty;
        // Every tracked position on this instrument (and posSide, in long/short mode) is ours
        const trackedLocals = Array.from(this.localPositions.values()).filter(
          (lp) =>
            lp.status === "OPEN" &&
            lp.instrumentId === exPos.instId &&
            (hedgeSide === null || lp.side === hedgeSide)
        );
        const matchingLocal = trackedLocals[0];
        const localQty = trackedLocals.reduce((sum, lp) => {
          const contracts = ScaledDecimal.fromString(lp.contracts);
          return lp.side === "long" ? sum.add(contracts) : sum.sub(contracts);
        }, ScaledDecimal.zero());
        const unhedgedQty = exPosQty.sub(localQty);

        if (!unhedgedQty.isZero()) {
          const foreignClOrdId =
            `kflatEx${nowMs.toString(36)}${sha256Hex(exPos.instId).slice(0, 10)}`.slice(0, 32);
          const foreignSide = unhedgedQty.isPositive() ? "sell" : "buy";
          const foreignSz = unhedgedQty.abs().toString();
          const foreignTdMode = exPos.mgnMode ?? "isolated";
          const foreignPosSide =
            exPos.posSide && exPos.posSide !== "net" ? exPos.posSide : undefined;

          const foreignBodyObj: Record<string, unknown> = {
            instId: exPos.instId,
            tdMode: foreignTdMode,
            side: foreignSide,
            ordType: "market",
            sz: foreignSz,
            reduceOnly: true,
            clOrdId: foreignClOrdId
          };
          if (foreignPosSide) {
            foreignBodyObj["posSide"] = foreignPosSide;
          }
          const foreignBody = JSON.stringify(foreignBodyObj);

          const foreignHeaders = buildOkxHeaders({
            method: "POST",
            path: "/api/v5/trade/order",
            body: foreignBody,
            credentials: creds,
            timestampIso: new Date(this.clock.nowMs()).toISOString(),
            isDemo: this.isDemoVenue()
          });

          let foreignSuccess = false;
          let foreignErrMsg = "";
          try {
            const foreignRes = await this.fetchFn("https://www.okx.com/api/v5/trade/order", {
              method: "POST",
              headers: foreignHeaders,
              body: foreignBody
            });
            if (foreignRes.ok) {
              const resData = (await foreignRes.json()) as {
                code?: string;
                msg?: string;
                data?: Array<{ sCode?: string; sMsg?: string }>;
              };
              if (resData.code === "0") {
                const item = resData.data?.[0];
                if (!item || !item.sCode || item.sCode === "0") {
                  foreignSuccess = true;
                } else {
                  foreignErrMsg = `sCode ${item.sCode}: ${item.sMsg ?? "unknown sub-error"}`;
                }
              } else {
                foreignErrMsg = `code ${resData.code}: ${resData.msg ?? "unknown error"}`;
              }
            } else {
              const errText = await foreignRes.text();
              foreignErrMsg = `HTTP ${foreignRes.status}: ${errText}`;
            }
          } catch (err) {
            foreignErrMsg = err instanceof Error ? err.message : String(err);
          }

          if (!foreignSuccess) {
            foreignFailures += 1;
            if (this.notificationChannel) {
              await this.notificationChannel.send({
                severity: "CRITICAL",
                title: "FOREIGN POSITION FLATTEN FAILED",
                body: `Failed to close untracked foreign exchange position ${exPos.instId} (${foreignSz} lots): ${foreignErrMsg}`,
                dedupKey: `foreign-flatten-fail-${exPos.instId}-${nowMs}`
              });
            }
          } else if (!matchingLocal) {
            await this.cancelProtectiveAlgos(exPos.instId, creds);
          }
        }
      }

      // 4. Disarm the dead-man's switch only once every position is confirmed flat
      if (sweepForeign && failedPositionIds.size === 0 && foreignFailures === 0) {
        const cancelPath = "/api/v5/trade/cancel-all-after";
        const cancelBody = JSON.stringify({ timeOut: "0" });
        try {
          await this.fetchFn(`https://www.okx.com${cancelPath}`, {
            method: "POST",
            headers: buildOkxHeaders({
              method: "POST",
              path: cancelPath,
              body: cancelBody,
              credentials: creds,
              timestampIso: new Date(this.clock.nowMs()).toISOString(),
              isDemo: this.isDemoVenue()
            }),
            body: cancelBody
          });
        } catch {
          // Leaving the DMS armed is the safe failure mode
        }
      }
    }

    const closed: PaperPositionRecord[] = [];

    for (const [id, pos] of this.localPositions.entries()) {
      if (pos.status === "OPEN" && include(pos) && !failedPositionIds.has(pos.positionId)) {
        const confirmed = confirmedFills.get(pos.positionId);
        if (!confirmed) {
          continue;
        }
        const exitPriceDec = ScaledDecimal.fromString(confirmed.exitPrice);
        const exitFee = confirmed.fee;

        const entryPriceDec = ScaledDecimal.fromString(pos.entryPrice);
        const contractsDec = ScaledDecimal.fromString(pos.contracts);
        const spec = getExchangeInstrumentSpec(pos.instrumentId);
        const grossPnl =
          pos.side === "long"
            ? contractsDec.mul(spec.contractValue).mul(exitPriceDec.sub(entryPriceDec))
            : contractsDec.mul(spec.contractValue).mul(entryPriceDec.sub(exitPriceDec));

        // Use confirmed real fee if available, else exitNotional fee
        const effectiveExitFee = exitFee;

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

          if (effectiveExitFee.isPositive()) {
            this.ledgerRepo.recordJournal({
              txGroupId: txGroup,
              ts: nowMs,
              strategyId: pos.strategyId,
              instrumentId: pos.instrumentId,
              debitAccount: "fees_expense:usdt",
              creditAccount: "cash:usdt",
              amountUsdt: effectiveExitFee.toFixed(8),
              description: `Exit execution fee on ${pos.positionId}`
            });
          }
        }

        const prevFees = ScaledDecimal.fromString(pos.feesPaidUsdt);
        const totalFees = prevFees.add(effectiveExitFee);

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
