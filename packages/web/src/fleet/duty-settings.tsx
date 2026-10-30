import { type ConfigFieldMetadata, type ConfigRiskClass, type KeelConfig } from "@keel/core";

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

/**
 * The Fleet's unattended duties (ADR-0030, ADR-0033), one control per registered `fleet.*`
 * setting, so a new setting shows up here as soon as it is in the registry. Changes join the
 * draft and are saved with the rest of the config, step-up included.
 */
export function DutySettings({
  config,
  registry,
  riskBadge,
  inputClass,
  onChange
}: {
  readonly config: FleetConfig;
  readonly registry: readonly ConfigFieldMetadata[];
  readonly riskBadge: Readonly<Record<ConfigRiskClass, string>>;
  readonly inputClass: string;
  readonly onChange: (fleet: FleetConfig) => void;
}) {
  const fields = registry.filter((f) => f.path.startsWith("fleet."));
  if (fields.length === 0) return null;
  const set = (key: FleetKey, value: FleetConfig[FleetKey]) =>
    onChange({ ...config, [key]: value });

  return (
    <div className="mt-6" data-testid="duty-settings">
      <h3 className="text-sm font-bold">Fleet duties</h3>
      <p className="mt-1 text-xs opacity-70">
        What the Fleet does on its own. Turn on the Night Shift and the Autopilot for a fleet Claude
        researches and fixed rules manage. Save with the button below.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {fields.map((field) => {
          const key = field.path.slice("fleet.".length) as FleetKey;
          const value = config[key];
          const choices = CHOICES[key];
          return (
            <div key={field.path} className="rounded-lg border border-slate-700/60 p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-semibold">{field.label}</span>
                <span
                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${riskBadge[field.riskClass]}`}
                >
                  {field.riskClass}
                </span>
              </div>
              <p className="mt-1 text-[11px] opacity-70">{field.helpText}</p>
              <div className="mt-2">
                {typeof value === "boolean" ? (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      data-testid={`duty-${key}`}
                      checked={value}
                      onChange={(e) => set(key, e.target.checked)}
                    />
                    <span>{value ? "On" : "Off"}</span>
                  </label>
                ) : typeof value === "number" ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      data-testid={`duty-${key}`}
                      className={inputClass}
                      value={value}
                      min={field.min}
                      max={field.max}
                      onChange={(e) => set(key, Number(e.target.value))}
                    />
                    {field.unit && <span className="text-xs opacity-70">{field.unit}</span>}
                  </div>
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
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
