import type { OkxFetchFn } from "../src/index.js";

interface FakeAlgo {
  readonly algoId: string;
  readonly instId: string;
  readonly attachAlgoClOrdId: string;
}

export interface FakeOkxOptions {
  /** When false, reduce-only close orders are rejected by the exchange. */
  readonly closeOrdersSucceed?: boolean;
  /** Pre-existing exchange positions returned by /account/positions. */
  readonly positions?: ReadonlyArray<{ instId: string; pos: string; posSide?: string }>;
}

/**
 * Stateful in-memory OKX V5 fake: entry orders fill and register their attached stop
 * as a pending algo; cancel-algo-orders removes algos; every request is journaled.
 */
export function createFakeOkx(options: FakeOkxOptions = {}) {
  const algos: FakeAlgo[] = [];
  const requests: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  const filledPx = new Map<string, string>();
  const filledSz = new Map<string, string>();
  let seq = 0;

  const ok = (data: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ code: "0", msg: "", data }),
    text: async () => ""
  });

  const fetchFn: OkxFetchFn = async (url, init) => {
    const path = url.replace("https://www.okx.com", "");
    const body: unknown = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method, path, body, headers: init.headers });

    if (path === "/api/v5/trade/order" && init.method === "POST") {
      const order = body as {
        instId: string;
        sz: string;
        reduceOnly?: boolean;
        attachAlgoOrds?: Array<{ attachAlgoClOrdId: string }>;
      };
      if (order.reduceOnly === true && options.closeOrdersSucceed === false) {
        return ok([{ sCode: "51008", sMsg: "Order failed" }]);
      }
      seq += 1;
      const ordId = `ord${seq}`;
      filledPx.set(ordId, order.reduceOnly === true ? "49000" : "50000");
      filledSz.set(ordId, order.sz);
      const attached = order.attachAlgoOrds?.[0];
      if (attached) {
        algos.push({
          algoId: `algo${seq}`,
          instId: order.instId,
          attachAlgoClOrdId: attached.attachAlgoClOrdId
        });
      }
      return ok([{ ordId, sCode: "0" }]);
    }

    if (path.startsWith("/api/v5/trade/order?") && init.method === "GET") {
      const ordId = new URL(`https://x${path}`).searchParams.get("ordId") ?? "";
      const px = filledPx.get(ordId);
      return ok(
        px ? [{ state: "filled", avgPx: px, accFillSz: filledSz.get(ordId), fee: "-0.3" }] : []
      );
    }

    if (path.startsWith("/api/v5/trade/orders-algo-pending")) {
      const instId = new URL(`https://x${path}`).searchParams.get("instId");
      return ok(algos.filter((a) => instId === null || a.instId === instId));
    }

    if (path === "/api/v5/trade/cancel-algo-orders") {
      for (const c of body as Array<{ algoId: string }>) {
        const idx = algos.findIndex((a) => a.algoId === c.algoId);
        if (idx >= 0) algos.splice(idx, 1);
      }
      return ok([{ sCode: "0" }]);
    }

    if (path === "/api/v5/account/positions") {
      return ok(options.positions ?? []);
    }

    return ok([]);
  };

  return {
    fetchFn,
    requests,
    pendingAlgos: (): readonly FakeAlgo[] => [...algos],
    calls: (pathPrefix: string) => requests.filter((r) => r.path.startsWith(pathPrefix))
  };
}
