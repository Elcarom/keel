import { useRef, useState } from "react";
import {
  rigMarkets,
  keelApiContract,
  type RigArchetype,
  type Bot,
  type Rig,
  type DesignSource,
  type Verdict
} from "@keel/core";
import { initClient } from "@ts-rest/core";

export const api = initClient(keelApiContract, { baseUrl: "", baseHeaders: {} });

export type Tab = "fleet" | "shipyard" | "treasury" | "logbook";

export function errorOf(body: unknown, fallback = "Something went wrong"): string {
  if (body !== null && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === "string") return e;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Formatting (display only: amounts arrive as exact decimal strings)
// ---------------------------------------------------------------------------

export const usd = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/** Instrument prices: two decimals for BTC, more for coins priced in cents. */
export function price(value: string | number): string {
  const n = Number(value);
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

export function money(value: string | number): string {
  return `${usd.format(Number(value))} USDT`;
}

export function signedMoney(value: string | number): string {
  const n = Number(value);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd.format(Math.abs(n))}`;
}

export function signedPct(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
}

export function tone(n: number): string {
  return n > 0 ? "text-emerald-300" : n < 0 ? "text-rose-300" : "text-slate-300";
}

export function ago(ms: number | null): string {
  if (ms === null) return "never";
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function pair(instrumentId: string): string {
  return instrumentId.replace("-USDT-SWAP", " perp");
}

export function coin(instrumentId: string): string {
  return instrumentId.replace("-USDT-SWAP", "");
}

/** A rig's optional exits, appended to its settings line. */
export function exitsLabel(b: Pick<Rig, "trailingAtrMultiple" | "maxBarsHeld">): string {
  return (
    (b.trailingAtrMultiple ? ` · trails ${b.trailingAtrMultiple}× ATR` : "") +
    (b.maxBarsHeld ? ` · out after ${b.maxBarsHeld}h` : "")
  );
}

/** The coins a boat trades: "BTC perp" for one, "SOL + AVAX + LINK" for a basket, "ETH vs BTC" for a pair. */
export function marketsLabel(
  b: Pick<Rig, "instrumentId" | "basket"> & Partial<Pick<Rig, "pairWith">>
): string {
  if (b.pairWith) return `${coin(b.instrumentId)} vs ${coin(b.pairWith)}`;
  const markets = rigMarkets(b);
  return markets.length === 1 ? pair(b.instrumentId) : markets.map(coin).join(" + ");
}

export const DIRECTION_LABELS = {
  both: "Long & short",
  long_only: "Long only",
  short_only: "Short only"
};

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

export function ArchetypeIcon({
  archetype,
  className = "h-5 w-5"
}: {
  archetype: RigArchetype;
  className?: string;
}) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };
  switch (archetype) {
    case "breakout":
      return (
        <svg {...common}>
          <path d="M3 15h7v-5h4v5h7" />
          <path d="M12 3v5M9.5 5.5 12 3l2.5 2.5" />
        </svg>
      );
    case "mean_reversion":
      return (
        <svg {...common}>
          <path d="M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 3-3 5-3" />
          <path d="M2 12h20" strokeDasharray="2 3" />
        </svg>
      );
    case "momentum":
      return (
        <svg {...common}>
          <path d="M12 3v15M12 3l7 11h-7M12 5 6 14h6" />
          <path d="M4 19c2.5 1.5 13.5 1.5 16 0" />
        </svg>
      );
    case "ma_crossover":
      return (
        <svg {...common}>
          <path d="M3 17c5 0 7-10 18-10" />
          <path d="M3 7c6 0 9 10 18 10" />
        </svg>
      );
    case "trend_pullback":
      return (
        <svg {...common}>
          <circle cx="12" cy="5" r="2" />
          <path d="M12 7v13M8 11h8M5 15c0 3 3 5 7 5s7-2 7-5" />
        </svg>
      );
    case "squeeze_breakout":
      return (
        <svg {...common}>
          <path d="M3 5c4 0 6 4 9 7M3 19c4 0 6-4 9-7" />
          <path d="M12 12h9M18 9l3 3-3 3" />
        </svg>
      );
    case "volume_breakout":
      return (
        <svg {...common}>
          <path d="M4 20v-3M8 20v-5M12 20v-9" />
          <path d="M18 15V5M15 8l3-3 3 3" />
        </svg>
      );
    case "inside_bar_breakout":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="6" height="14" rx="1" />
          <rect x="12" y="8.5" width="4" height="7" rx="1" />
          <path d="M20 4v8M17.5 6.5 20 4l2.5 2.5" />
        </svg>
      );
    case "keltner_ride":
      return (
        <svg {...common}>
          <path d="M2 8c6-3 14-3 20 0M2 16c6 3 14 3 20 0" strokeDasharray="2 3" />
          <path d="M3 17c5-2 9-8 18-12" />
        </svg>
      );
    case "regime_momentum":
      return (
        <svg {...common}>
          <path d="M2 18c4-1 6-4 9-4s6-6 11-9" />
          <path d="M16 5h6v6" />
          <path d="M2 21h20" strokeDasharray="2 3" />
        </svg>
      );
    case "rsi_reversal":
      return (
        <svg {...common}>
          <path d="M4 17a8 8 0 0 1 16 0" />
          <path d="M12 17 8.5 11.5" />
          <path d="M4.5 13h2M17.5 13h2" />
        </svg>
      );
    case "failed_breakout":
      return (
        <svg {...common}>
          <path d="M3 8h18" strokeDasharray="2 3" />
          <path d="M3 19h4l4-15 3 9h7" />
        </svg>
      );
    case "invented":
      return (
        <svg {...common}>
          <path d="M12 2.5 14 10l7.5 2-7.5 2-2 7.5-2-7.5-7.5-2 7.5-2Z" />
          <circle cx="12" cy="12" r="1.2" />
        </svg>
      );
    case "capitulation_fade":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3.5" />
          <path d="m6.3 6.3 3.2 3.2M14.5 14.5l3.2 3.2M17.7 6.3l-3.2 3.2M9.5 14.5l-3.2 3.2" />
        </svg>
      );
    case "pair_reversion":
      return (
        <svg {...common}>
          <path d="M3 8c3-3 6 3 9 0s6 3 9 0" />
          <path d="M3 16c3 3 6-3 9 0s6-3 9 0" />
          <path d="M12 9.5v5" />
        </svg>
      );
    case "pair_momentum":
      return (
        <svg {...common}>
          <path d="M3 17 10 10l3 3 8-8" />
          <path d="M3 20h18" />
          <path d="M16 5h5v5" />
        </svg>
      );
  }
}

/** A design's rules as Keel reads them, one line each. */
export function InventionRules({ rules }: { rules: readonly string[] }) {
  return (
    <ul className="space-y-1 rounded-xl border border-violet-400/25 bg-violet-400/5 p-3 text-xs text-slate-200">
      {rules.map((r) => (
        <li key={r} className="flex gap-2">
          <span aria-hidden className="text-violet-300">
            ›
          </span>
          {r}
        </li>
      ))}
    </ul>
  );
}

export const INVENTED_BADGES: Record<DesignSource, string> = {
  claude: "✦ Drawn up by Claude",
  imported: "✦ Drawn up in a chat",
  sample: "✦ Sample design"
};

export function InventedBadge({ source }: { source: DesignSource }) {
  return (
    <span className="rounded-full border border-violet-400/40 bg-violet-400/10 px-2 py-0.5 text-[11px] font-semibold text-violet-200">
      {INVENTED_BADGES[source]}
    </span>
  );
}

export function KeelMark() {
  return (
    <svg aria-label="Keel" className="h-8 w-8" viewBox="0 0 32 32" fill="none">
      <path
        d="M5 11C5 18.5 10.5 23 16 25C21.5 23 27 18.5 27 11H5Z"
        stroke="#2DD4BF"
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
    </svg>
  );
}

export const VERDICTS: Record<Verdict, { label: string; className: string; glyph: string }> = {
  seaworthy: {
    label: "Seaworthy",
    glyph: "✓",
    className: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
  },
  promising: {
    label: "Promising",
    glyph: "↗",
    className: "border-sky-400/40 bg-sky-400/10 text-sky-200"
  },
  choppy: {
    label: "Choppy waters",
    glyph: "~",
    className: "border-amber-400/40 bg-amber-400/10 text-amber-200"
  },
  sinks: {
    label: "Takes on water",
    glyph: "↓",
    className: "border-rose-400/40 bg-rose-400/10 text-rose-200"
  }
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const v = VERDICTS[verdict];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${v.className}`}
    >
      <span aria-hidden>{v.glyph}</span>
      {v.label}
    </span>
  );
}

export const STATUS_CHIPS: Record<Bot["status"], { label: string; dot: string; text: string }> = {
  running: { label: "At sea", dot: "bg-teal-300 animate-pulse", text: "text-teal-200" },
  paused: { label: "In harbour", dot: "bg-amber-300", text: "text-amber-200" },
  retired: { label: "Retired", dot: "bg-slate-500", text: "text-slate-400" }
};

export function StatusChip({ status }: { status: Bot["status"] }) {
  const s = STATUS_CHIPS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${s.text}`}>
      <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

/** Single-series line with a hover readout; the card's title names the series. */
export function Sparkline({
  values,
  format,
  label,
  height = 44
}: {
  values: readonly number[];
  format: (v: number) => string;
  label: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const width = 240;
  if (values.length < 2) {
    return (
      <div className="flex items-center text-[11px] text-slate-500" style={{ height }}>
        Not enough voyage yet to draw a course
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 4;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const stroke = last >= first ? "#5EEAD4" : "#FDA4AF";
  const hv = hover !== null ? values[hover] : undefined;

  return (
    <div className="relative">
      <svg
        ref={ref}
        role="img"
        aria-label={`${label}: from ${format(first)} to ${format(last)}`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block w-full cursor-crosshair"
        style={{ height }}
        onMouseMove={(e) => {
          const rect = ref.current?.getBoundingClientRect();
          if (!rect) return;
          const ratio = (e.clientX - rect.left) / rect.width;
          setHover(
            Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1))))
          );
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line
          x1="0"
          x2={width}
          y1={y(first)}
          y2={y(first)}
          stroke="#334155"
          strokeWidth="1"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null && hv !== undefined && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1="0"
            y2={height}
            stroke="#94A3B8"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hover !== null && hv !== undefined && (
        <div
          className="pointer-events-none absolute -top-7 rounded-md border border-slate-600 bg-slate-900 px-2 py-0.5 text-[11px] font-mono-tabular text-slate-100 shadow"
          style={{
            left: `clamp(0px, calc(${(hover / (values.length - 1)) * 100}% - 40px), calc(100% - 90px))`
          }}
        >
          {format(hv)}
        </div>
      )}
    </div>
  );
}

export function Stat({
  label,
  value,
  valueClass = "text-slate-100",
  hint
}: {
  label: string;
  value: string;
  valueClass?: string | undefined;
  hint?: string | undefined;
}) {
  return (
    <div>
      <div className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className={`font-mono-tabular text-sm font-semibold ${valueClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

export function Banner({
  kind,
  children,
  testId
}: {
  kind: "warn" | "danger" | "info" | "ok";
  children: React.ReactNode;
  testId?: string;
}) {
  const styles = {
    warn: "border-amber-400/40 bg-amber-400/10 text-amber-100",
    danger: "border-rose-400/50 bg-rose-500/10 text-rose-100",
    info: "border-sky-400/30 bg-sky-400/10 text-sky-100",
    ok: "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
  };
  return (
    <div data-testid={testId} className={`rounded-xl border px-4 py-3 text-sm ${styles[kind]}`}>
      {children}
    </div>
  );
}

export const card = "rounded-2xl border border-[#243140] bg-[#141B23] p-5 shadow-sm";
export const input =
  "w-full rounded-lg border border-[#2B3947] bg-[#0F1419] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-teal-400 focus:outline-none";
export const primaryBtn =
  "rounded-lg bg-teal-500 px-4 py-2 text-sm font-semibold text-[#06201D] hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-50";
export const ghostBtn =
  "rounded-lg border border-[#2B3947] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-slate-400 disabled:opacity-50";
export const dangerBtn =
  "rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/15";

export function Chip({
  selected,
  onClick,
  children,
  testId
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
        selected
          ? "border-teal-400 bg-teal-400/15 text-teal-100"
          : "border-[#2B3947] text-slate-300 hover:border-slate-400"
      }`}
    >
      {children}
    </button>
  );
}
