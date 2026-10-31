import { type ConfigFieldMetadata, type FleetDutyStatus, type KeelConfig } from "@keel/core";
import { ago } from "./ui.js";

type FleetConfig = KeelConfig["fleet"];
type FleetKey = keyof FleetConfig;

/** The choices of the duty settings that are a fixed list rather than free text. */
const CHOICES: Partial<Record<FleetKey, readonly (readonly [string, string])[]>> = {
  nightShiftCadence: [
    ["daily", "Every night"],
    ["weekly", "Mondays only"]
  ],
  nightShiftMode: [
    ["inventor", "Inventor: Claude writes new rules"],
    ["blueprint", "Blueprints: Claude tunes reviewed shapes"]
  ]
};

/** The duties' settings in three groups, each led by its on/off switch. */
const GROUPS: readonly {
  readonly title: string;
  readonly duties: readonly FleetDutyStatus["duty"][];
  readonly owns: (key: string) => boolean;
}[] = [
  { title: "Night shift", duties: ["nightShift"], owns: (k) => k.startsWith("nightShift") },
  { title: "Autopilot", duties: ["autopilot"], owns: (k) => k.startsWith("autopilot") },
  {
    title: "Upkeep",
    duties: ["driftWatch", "digest", "rebalance"],
    owns: (k) => !k.startsWith("nightShift") && !k.startsWith("autopilot")
  }
];

/**
 * The Fleet's unattended duties (ADR-0030, ADR-0033), one control per registered `fleet.*`
 * setting, so a new setting shows up here as soon as it is in the registry. Each group shows
 * what its duties last did. Changes join the draft and are saved with the rest of the config.
 */
export function DutySettings({
  config,
  registry,
  duties,
  inputClass,
  onChange
}: {
  readonly config: FleetConfig;
  readonly registry: readonly ConfigFieldMetadata[];
  readonly duties: readonly FleetDutyStatus[];
  readonly inputClass: string;
  readonly onChange: (fleet: FleetConfig) => void;
}) {
  const fields = registry.filter((f) => f.path.startsWith("fleet."));
  if (fields.length === 0) return null;
  const set = (key: FleetKey, value: FleetConfig[FleetKey]) =>
    onChange({ ...config, [key]: value });

  const control = (field: ConfigFieldMetadata) => {
    const key = field.path.slice("fleet.".length) as FleetKey;
    const value = config[key];
    const choices = CHOICES[key];
    if (typeof value === "boolean") {
      return (
        <label key={field.path} className="flex items-start gap-2 text-xs sm:col-span-2">
          <input
            type="checkbox"
            className="mt-0.5"
            data-testid={`duty-${key}`}
            checked={value}
            onChange={(e) => set(key, e.target.checked)}
          />
          <span>
            <span className="font-semibold text-slate-200">{field.label}</span>
            <span className="block text-[11px] text-slate-400">{field.helpText}</span>
          </span>
        </label>
      );
    }
    return (
      <label key={field.path} className="block text-xs" title={field.helpText}>
        <span className="font-semibold text-slate-200">{field.label}</span>
        <div className="mt-1 flex items-center gap-2">
          {typeof value === "number" ? (
            <input
              type="number"
              data-testid={`duty-${key}`}
              className={`${inputClass} max-w-[9rem]`}
              value={value}
              min={field.min}
              max={field.max}
              onChange={(e) => set(key, Number(e.target.value))}
            />
          ) : choices ? (
            <select
              data-testid={`duty-${key}`}
              className={inputClass}
              value={value}
              onChange={(e) => set(key, e.target.value as FleetConfig[FleetKey])}
            >
              {choices.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              data-testid={`duty-${key}`}
              className={inputClass}
              value={value}
              onChange={(e) => set(key, e.target.value as FleetConfig[FleetKey])}
            />
          )}
          {field.unit && <span className="text-slate-400">{field.unit}</span>}
        </div>
        <span className="mt-0.5 block text-[11px] text-slate-500">{field.helpText}</span>
      </label>
    );
  };

  return (
    <div data-testid="duty-settings" className="space-y-3">
      {GROUPS.map((group) => {
        const mine = fields.filter((f) => group.owns(f.path.slice("fleet.".length)));
        // Switches first, so each group opens with what turns it on
        const ordered = [
          ...mine.filter((f) => f.path.endsWith("Enabled")),
          ...mine.filter((f) => !f.path.endsWith("Enabled"))
        ];
        const status = duties.filter((d) => group.duties.includes(d.duty));
        return (
          <div key={group.title} className="rounded-xl border border-[#243140] p-4">
            <h3 className="text-sm font-semibold text-slate-100">{group.title}</h3>
            {status.map((d) => (
              <p key={d.duty} className="mt-0.5 text-[11px] text-slate-400">
                <span className={d.enabled ? "text-emerald-300" : "text-slate-500"}>
                  {d.enabled ? "●" : "○"}
                </span>{" "}
                {status.length > 1 ? `${d.label}: ` : ""}
                {d.note ?? (d.enabled ? "Waiting for its first run" : "Off")}
                {d.lastRunMs ? ` · ${ago(d.lastRunMs)}` : ""}
              </p>
            ))}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">{ordered.map(control)}</div>
          </div>
        );
      })}
    </div>
  );
}
