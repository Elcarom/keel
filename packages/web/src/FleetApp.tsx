import { useCallback, useEffect, useMemo, useState } from "react";
import { type Bot, type FleetOverview } from "@keel/core";
import { BoatPage } from "./fleet/boat-page.js";
import { FleetView } from "./fleet/fleet-view.js";
import { LogbookView } from "./fleet/logbook.js";
import { ShipyardView } from "./fleet/shipyard.js";
import { TreasuryView } from "./fleet/treasury.js";
import { Banner, KeelMark, type Tab, api, errorOf, ghostBtn } from "./fleet/ui.js";

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function FleetApp({
  username,
  onOpenEngineRoom,
  onSignedOut
}: {
  username: string | null;
  onOpenEngineRoom: () => void;
  onSignedOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("fleet");
  const [boatId, setBoatId] = useState<string | null>(null);
  const [overview, setOverview] = useState<FleetOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const res = await api.fleet.getOverview();
    if (res.status === 200) {
      setOverview(res.body);
      setLoadError(null);
    } else if (res.status === 401) {
      onSignedOut();
    } else {
      setLoadError("Could not reach the fleet");
    }
  }, [onSignedOut]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const signOut = async () => {
    await api.auth.logout({ body: {} });
    onSignedOut();
  };

  const go = (next: Tab) => {
    setTab(next);
    setBoatId(null);
  };
  const openBoat = (id: string) => {
    setTab("fleet");
    setBoatId(id);
  };

  /** Docking and setting sail from a boat's own page. */
  const boatAction = async (bot: Bot, action: "pause" | "resume" | "retire" | "delete") => {
    setBusy(true);
    const params = { botId: bot.botId };
    const res =
      action === "pause"
        ? await api.fleet.pauseBot({ params, body: {} })
        : action === "resume"
          ? await api.fleet.resumeBot({ params, body: {} })
          : action === "retire"
            ? await api.fleet.retireBot({ params, body: {} })
            : await api.fleet.deleteBot({ params, body: {} });
    setBusy(false);
    if (res.status !== 200) setLoadError(errorOf(res.body));
    await reload();
  };

  const tabs = useMemo(
    () =>
      [
        [
          "fleet",
          "Fleet",
          overview ? overview.bots.filter((b) => b.status !== "retired").length : null
        ],
        ["shipyard", "Shipyard", null],
        ["treasury", "Treasury", overview ? overview.wallets.length : null],
        ["logbook", "Logbook", null]
      ] as const,
    [overview]
  );
  const boat = boatId ? (overview?.bots.find((b) => b.botId === boatId) ?? null) : null;

  return (
    <div className="min-h-screen bg-[#0B1016] text-slate-100" data-testid="fleet-app">
      <header className="border-b border-[#1E2833] bg-[#0F151C]/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <KeelMark />
            <div>
              <div className="text-lg leading-none font-bold tracking-tight">Keel</div>
              <div className="text-[11px] text-slate-400">steady hands for restless markets</div>
            </div>
          </div>
          <nav
            className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:ml-6 sm:w-auto"
            aria-label="Sections"
          >
            {tabs.map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                data-testid={`tab-${id}`}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => go(id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold whitespace-nowrap transition ${
                  tab === id
                    ? "bg-teal-400/15 text-teal-100"
                    : "text-slate-400 hover:text-slate-100"
                }`}
              >
                {label}
                {count !== null && <span className="ml-1.5 text-xs text-slate-500">{count}</span>}
              </button>
            ))}
            <button
              type="button"
              data-testid="open-engine-room"
              onClick={onOpenEngineRoom}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-slate-400 transition hover:text-slate-100"
            >
              Engine Room ↗
            </button>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs">
            <span className="hidden text-slate-400 sm:inline">Captain {username}</span>
            <button type="button" className={ghostBtn} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {loadError && <Banner kind="danger">{loadError}</Banner>}
        {!overview ? (
          <p className="text-sm text-slate-400">Taking a headcount of the fleet…</p>
        ) : boat ? (
          <BoatPage
            bot={boat}
            busy={busy}
            onBack={() => setBoatId(null)}
            onAction={(b, a) => void boatAction(b, a)}
          />
        ) : tab === "fleet" ? (
          <FleetView
            overview={overview}
            reload={reload}
            goShipyard={() => go("shipyard")}
            onOpenBoat={openBoat}
          />
        ) : tab === "shipyard" ? (
          <ShipyardView overview={overview} reloadFleet={reload} goFleet={() => go("fleet")} />
        ) : tab === "treasury" ? (
          <TreasuryView overview={overview} reload={reload} />
        ) : (
          <LogbookView overview={overview} onOpenBoat={openBoat} />
        )}
      </main>
    </div>
  );
}
