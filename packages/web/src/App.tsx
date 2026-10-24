import { useEffect, useState } from "react";
import type { SystemStatusResponse } from "@keel/core";

export function App() {
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [streamConnected, setStreamConnected] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/system/status")
      .then((res) => res.json() as Promise<SystemStatusResponse>)
      .then((data) => {
        if (active) {
          setStatus(data);
        }
      })
      .catch(() => {
        // Handled by offline indicator in UI
      });

    const source = new EventSource("/api/v1/stream/heartbeat");
    source.addEventListener("heartbeat", () => {
      if (active) {
        setStreamConnected(true);
      }
    });
    source.onerror = () => {
      if (active) {
        setStreamConnected(false);
      }
    };

    return () => {
      active = false;
      source.close();
    };
  }, []);

  const isDark = theme === "dark";
  const executionMode = status?.executionMode ?? "Paper";

  return (
    <div
      className={
        isDark
          ? "min-h-screen bg-[#0F1419] text-slate-100 transition-colors"
          : "min-h-screen bg-[#FBF9F5] text-[#182026] transition-colors"
      }
    >
      <header
        className={
          isDark
            ? "border-b border-[#222C36] bg-[#161D24] px-6 py-4"
            : "border-b border-stone-300 bg-[#F3EFE6] px-6 py-4"
        }
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* Keel Logo Mark: Hull Cross-Section & Error-Bar Balance Spine */}
            <svg
              aria-label="Keel logo"
              className="h-8 w-8 text-[#0D9488]"
              viewBox="0 0 32 32"
              fill="none"
            >
              <path
                d="M5 11C5 18.5 10.5 23 16 25C21.5 23 27 18.5 27 11H5Z"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinejoin="round"
              />
              <line
                x1="16"
                y1="5"
                x2="16"
                y2="28"
                stroke="#F59E0B"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <line
                x1="12"
                y1="6"
                x2="20"
                y2="6"
                stroke="#F59E0B"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Keel</h1>
              <p className="text-xs opacity-75">
                Systematic Crypto-Derivatives Research &amp; Execution
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              data-testid="execution-mode-badge"
              className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/40 bg-teal-500/15 px-3 py-1 text-xs font-semibold tracking-wider text-teal-400 uppercase"
            >
              <span className="h-2 w-2 rounded-full bg-teal-400" />
              {executionMode}
            </span>

            <span
              data-testid="heartbeat-indicator"
              className="font-mono-tabular inline-flex items-center gap-1.5 rounded-md border border-slate-700/60 px-2.5 py-1 text-xs"
            >
              <span
                className={
                  streamConnected || status?.status === "ok"
                    ? "h-2 w-2 rounded-full bg-emerald-400"
                    : "h-2 w-2 rounded-full bg-amber-400"
                }
              />
              {status?.status === "ok" ? "HEARTBEAT OK" : "CONNECTING"}
            </span>

            <button
              type="button"
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="rounded-md border border-slate-600/50 px-3 py-1 text-xs font-medium hover:border-teal-500"
            >
              {isDark ? "Chart Paper (Light)" : "Night Watch (Dark)"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid gap-6 md:grid-cols-3">
          <section
            className={
              isDark
                ? "rounded-xl border border-[#222C36] bg-[#161D24] p-5"
                : "rounded-xl border border-stone-300 bg-[#F3EFE6] p-5"
            }
          >
            <h2 className="text-xs font-semibold tracking-wider uppercase opacity-70">
              Paper Portfolio Equity
            </h2>
            <p
              data-testid="paper-equity-display"
              className="font-mono-tabular mt-2 text-2xl font-semibold text-emerald-400"
            >
              10,000.00 USDT
            </p>
            <p className="mt-1 text-xs opacity-70">
              Unit Risk (1R): <span className="font-mono-tabular">0.75% (75.00 USDT)</span>
            </p>
          </section>

          <section
            className={
              isDark
                ? "rounded-xl border border-[#222C36] bg-[#161D24] p-5"
                : "rounded-xl border border-stone-300 bg-[#F3EFE6] p-5"
            }
          >
            <h2 className="text-xs font-semibold tracking-wider uppercase opacity-70">
              Deterministic Config Hash
            </h2>
            <p
              data-testid="config-hash-display"
              className="font-mono-tabular mt-2 text-lg font-medium"
            >
              {status ? status.configHash.slice(0, 16) : "----------------"}
            </p>
            <p className="mt-1 text-xs opacity-70">
              Shutdown Policy:{" "}
              <span className="font-mono-tabular">hold (Protective Stops active)</span>
            </p>
          </section>

          <section
            className={
              isDark
                ? "rounded-xl border border-[#222C36] bg-[#161D24] p-5"
                : "rounded-xl border border-stone-300 bg-[#F3EFE6] p-5"
            }
          >
            <h2 className="text-xs font-semibold tracking-wider uppercase opacity-70">
              Ingress &amp; Clock Telemetry
            </h2>
            <p
              data-testid="server-clock-display"
              className="font-mono-tabular mt-2 text-sm font-medium"
            >
              {status ? status.serverTimeIso : "Synchronizing clock..."}
            </p>
            <p className="mt-1 text-xs opacity-70">
              Cloudflare Tunnel:{" "}
              <span className="font-mono-tabular">
                {status?.cloudflareTunnelActive ? "Detected" : "Direct / Local"}
              </span>
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
