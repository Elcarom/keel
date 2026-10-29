import {
  BOT_DIRECTIONS,
  BotBlueprintSchema,
  FLEET_INSTRUMENTS,
  INDICATOR_KINDS,
  MAX_IMPORTED_INVENTIONS,
  type BotBlueprint,
  type DesignBrief,
  type FleetInstrument,
  type Invention
} from "@keel/core";
import { z } from "zod";
import { compileBlueprint } from "./blueprint.js";
import { ConditionSchema, type Condition, type NumExpr } from "./index.js";
import { INDICATOR_OUTPUTS, MAX_INVENTION_SHIFT, describeInvention } from "./invention.js";

/** What Claude returns for one invention, before Keel has checked a single rule. */
export const InventionDraftSchema = z.object({
  name: z.string().min(1).max(80),
  tagline: z.string().min(1).max(300),
  rationale: z.string().max(2000),
  instrumentId: z.string(),
  direction: z.enum(BOT_DIRECTIONS),
  indicators: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,23}$/, "ids are letters, digits and _"),
        kind: z.enum(INDICATOR_KINDS),
        period: z.number()
      })
    )
    .min(1)
    .max(6),
  longEntry: z.unknown(),
  shortEntry: z.unknown(),
  stopAtrMultiple: z.number(),
  rewardMultiple: z.number()
});

export type InventionCheck =
  | { readonly ok: true; readonly blueprint: BotBlueprint }
  | { readonly ok: false; readonly name: string; readonly error: string };

function zodMessage(error: z.ZodError, prefix = ""): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${prefix}${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function clamp(value: number, min: number, max: number, integer = false): number {
  const v = Number.isFinite(value) ? value : min;
  const c = Math.min(max, Math.max(min, v));
  return integer ? Math.round(c) : Math.round(c * 100) / 100;
}

/** Every reference problem in an expression: unknown ids, outputs a kind lacks, long shifts. */
function exprProblems(expr: NumExpr, kinds: ReadonlyMap<string, string>, where: string): string[] {
  switch (expr.type) {
    case "constant":
      return Number.isFinite(expr.value) ? [] : [`${where}: constants must be finite numbers`];
    case "bar_field":
      return (expr.shift ?? 0) > MAX_INVENTION_SHIFT
        ? [`${where}: shift ${expr.shift} is longer than ${MAX_INVENTION_SHIFT} bars`]
        : [];
    case "indicator": {
      const kind = kinds.get(expr.id);
      if (!kind) return [`${where}: no indicator has id "${expr.id}"`];
      const outputs = INDICATOR_OUTPUTS[kind as keyof typeof INDICATOR_OUTPUTS];
      const problems: string[] = [];
      if (!expr.output || !outputs.includes(expr.output)) {
        problems.push(
          `${where}: indicator "${expr.id}" (${kind}) needs output one of ${outputs.join(", ")}`
        );
      }
      if ((expr.shift ?? 0) > MAX_INVENTION_SHIFT) {
        problems.push(`${where}: shift ${expr.shift} is longer than ${MAX_INVENTION_SHIFT} bars`);
      }
      return problems;
    }
    case "binary_op":
      return [...exprProblems(expr.left, kinds, where), ...exprProblems(expr.right, kinds, where)];
  }
}

function conditionProblems(
  cond: Condition,
  kinds: ReadonlyMap<string, string>,
  where: string
): string[] {
  switch (cond.type) {
    case "comparison":
      return [...exprProblems(cond.left, kinds, where), ...exprProblems(cond.right, kinds, where)];
    case "crosses_above":
    case "crosses_below":
      return [
        ...exprProblems(cond.seriesA, kinds, where),
        ...exprProblems(cond.seriesB, kinds, where)
      ];
    case "logical_op":
      if (cond.operands.length === 0) return [`${where}: and/or needs at least one operand`];
      return cond.operands.flatMap((o) => conditionProblems(o, kinds, where));
  }
}

/**
 * Checks one invention as Claude wrote it and turns it into a blueprint. The brief's instruments
 * and direction override the model's; numbers outside the reviewed ranges are clamped; anything
 * that would not compile is reported in words Claude can act on.
 */
export function checkInvention(
  raw: unknown,
  brief: Pick<DesignBrief, "instruments" | "direction">
): InventionCheck {
  const nameOf = (): string => {
    if (typeof raw === "object" && raw !== null && "name" in raw) {
      const n = (raw as { name: unknown }).name;
      if (typeof n === "string") return n;
    }
    return "(unnamed)";
  };
  const fail = (error: string): InventionCheck => ({ ok: false, name: nameOf(), error });

  const draft = InventionDraftSchema.safeParse(raw);
  if (!draft.success) return fail(zodMessage(draft.error));
  const d = draft.data;

  const ids = d.indicators.map((i) => i.id);
  if (new Set(ids).size !== ids.length) return fail("indicator ids must be unique");
  const kinds = new Map(d.indicators.map((i) => [i.id, i.kind]));

  const long = ConditionSchema.safeParse(d.longEntry);
  if (!long.success) return fail(zodMessage(long.error, "longEntry."));
  const short = ConditionSchema.safeParse(d.shortEntry);
  if (!short.success) return fail(zodMessage(short.error, "shortEntry."));
  const problems = [
    ...conditionProblems(long.data, kinds, "longEntry"),
    ...conditionProblems(short.data, kinds, "shortEntry")
  ];
  if (problems.length > 0) return fail(problems.slice(0, 4).join("; "));

  const instruments: readonly string[] = brief.instruments;
  const instrumentId: FleetInstrument = instruments.includes(d.instrumentId)
    ? (d.instrumentId as FleetInstrument)
    : (brief.instruments[0] ?? FLEET_INSTRUMENTS[0]);
  const direction = brief.direction === "any" ? d.direction : brief.direction;
  const indicators = d.indicators.map((i) => ({ ...i, period: clamp(i.period, 2, 200, true) }));
  const periods = indicators.map((i) => i.period);
  const lookbackPeriod = clamp(Math.max(...periods), 5, 200, true);
  const fastPeriod = clamp(Math.min(...periods, lookbackPeriod - 2), 3, 100, true);
  const stopAtrMultiple = clamp(d.stopAtrMultiple, 0.5, 6);
  const rewardMultiple = clamp(d.rewardMultiple, 0.8, 6);

  const invention: Invention = {
    indicators,
    longEntry: long.data,
    shortEntry: short.data,
    rules: []
  };
  const blueprint = BotBlueprintSchema.parse({
    name: d.name.trim().slice(0, 40),
    tagline: d.tagline.trim().slice(0, 160),
    archetype: "invented",
    instrumentId,
    direction,
    lookbackPeriod,
    fastPeriod,
    entryThreshold: 1,
    stopAtrMultiple,
    rewardMultiple,
    rationale: d.rationale.trim().slice(0, 600),
    invention: {
      ...invention,
      rules: describeInvention({ direction, stopAtrMultiple, rewardMultiple }, invention)
    }
  });

  try {
    compileBlueprint(blueprint, "invention_check");
  } catch (err) {
    if (err instanceof z.ZodError) return fail(zodMessage(err));
    return fail(err instanceof Error ? err.message : String(err));
  }
  return { ok: true, blueprint };
}

/**
 * Checks an invention from an imported file. No brief stands behind a file, so the invention keeps
 * its own instrument and direction, and an instrument Keel does not trade is an error rather
 * than quietly replaced.
 */
export function checkImportedInvention(raw: unknown): InventionCheck {
  const check = checkInvention(raw, { instruments: [...FLEET_INSTRUMENTS], direction: "any" });
  if (!check.ok) return check;
  const asked =
    typeof raw === "object" && raw !== null && "instrumentId" in raw
      ? (raw as { instrumentId: unknown }).instrumentId
      : undefined;
  if (asked !== check.blueprint.instrumentId) {
    return {
      ok: false,
      name: check.blueprint.name,
      error: `instrumentId must be one of ${FLEET_INSTRUMENTS.join(", ")}`
    };
  }
  return check;
}

export type InventionFileRead =
  | { readonly ok: true; readonly inventions: readonly unknown[] }
  | { readonly ok: false; readonly error: string };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads the inventions out of a file or a pasted Claude reply: plain JSON, a fenced ```json
 * block, or JSON with prose around it. The JSON may be {"propositions": [...]},
 * {"inventions": [...]}, a bare array or a single invention.
 */
export function readInventionFile(text: string): InventionFileRead {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(trimmed)?.[1];
  const firstBrace = trimmed.search(/[[{]/);
  const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  const json =
    parseJson(trimmed) ??
    (fenced === undefined ? undefined : parseJson(fenced)) ??
    (firstBrace >= 0 && lastBrace > firstBrace
      ? parseJson(trimmed.slice(firstBrace, lastBrace + 1))
      : undefined);
  if (json === undefined) {
    return { ok: false, error: "No JSON found. Paste Claude's reply or choose the .json file." };
  }

  const list: unknown = Array.isArray(json)
    ? json
    : typeof json === "object" && json !== null
      ? ((json as Record<string, unknown>)["propositions"] ??
        (json as Record<string, unknown>)["inventions"] ??
        ("longEntry" in json ? [json] : undefined))
      : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    return {
      ok: false,
      error: 'Expected {"propositions": [...]} with at least one invention in it.'
    };
  }
  if (list.length > MAX_IMPORTED_INVENTIONS) {
    return {
      ok: false,
      error: `The file holds ${list.length} inventions; import at most ${MAX_IMPORTED_INVENTIONS} at a time.`
    };
  }
  return { ok: true, inventions: list };
}
