import {
  BOT_DIRECTIONS,
  RigSchema,
  FLEET_INSTRUMENTS,
  INDICATOR_KINDS,
  MAX_BOAT_MARKETS,
  MAX_IMPORTED_INVENTIONS,
  rigMarkets,
  type Rig,
  type DesignBrief,
  type FleetInstrument,
  type Invention
} from "@keel/core";
import { z } from "zod";
import { compileRig } from "./rig.js";
import { ConditionSchema, type Condition, type NumExpr } from "./index.js";
import { HigherTimeframeSchema, TIMEFRAME_HOURS } from "./timeframes.js";
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
        period: z.number(),
        market: z.string().optional(),
        timeframe: HigherTimeframeSchema.optional()
      })
    )
    .min(1)
    .max(6),
  longEntry: z.unknown(),
  shortEntry: z.unknown(),
  stopAtrMultiple: z.number(),
  rewardMultiple: z.number(),
  longExit: z.unknown().optional(),
  shortExit: z.unknown().optional(),
  trailingAtrMultiple: z.number().nullable().optional(),
  maxBarsHeld: z.number().nullable().optional(),
  basket: z.array(z.string()).max(20).optional(),
  /** The second coin of a pair, held against instrumentId (ADR-0032). */
  pairWith: z.string().nullable().optional()
});

export type InventionCheck =
  | { readonly ok: true; readonly rig: Rig }
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
const isFleetInstrument = (market: string): boolean =>
  (FLEET_INSTRUMENTS as readonly string[]).includes(market);

const MARKET_LIST = FLEET_INSTRUMENTS.join(", ");

/** Higher-timeframe windows and shifts stay inside the Spec's 500-bar lookback (20 days). */
const MAX_HIGHER_TIMEFRAME_HOURS = 480;

function exprProblems(expr: NumExpr, kinds: ReadonlyMap<string, string>, where: string): string[] {
  switch (expr.type) {
    case "constant":
      return Number.isFinite(expr.value) ? [] : [`${where}: constants must be finite numbers`];
    case "bar_field": {
      const problems: string[] = [];
      if ((expr.shift ?? 0) > MAX_INVENTION_SHIFT) {
        problems.push(`${where}: shift ${expr.shift} is longer than ${MAX_INVENTION_SHIFT} bars`);
      }
      if (expr.market !== undefined && !isFleetInstrument(expr.market)) {
        problems.push(`${where}: market "${expr.market}" must be one of ${MARKET_LIST}`);
      }
      if (expr.field === "funding" && (expr.market !== undefined || expr.timeframe !== undefined)) {
        problems.push(`${where}: funding is read for the traded coin on 1H bars only`);
      }
      const hours = expr.timeframe ? TIMEFRAME_HOURS[expr.timeframe] : 1;
      if ((expr.shift ?? 0) * hours > MAX_HIGHER_TIMEFRAME_HOURS) {
        problems.push(`${where}: a ${expr.timeframe} shift of ${expr.shift} reaches back too far`);
      }
      return problems;
    }
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
 * Checks one invention as Claude wrote it and turns it into a rig. The brief's instruments
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
  const tooLong = d.indicators.find(
    (i) =>
      i.timeframe !== undefined &&
      i.period * TIMEFRAME_HOURS[i.timeframe] > MAX_HIGHER_TIMEFRAME_HOURS
  );
  if (tooLong?.timeframe) {
    return fail(
      `indicator "${tooLong.id}": a ${tooLong.timeframe} period may cover at most ${MAX_HIGHER_TIMEFRAME_HOURS / TIMEFRAME_HOURS[tooLong.timeframe]} bars`
    );
  }
  const unpaired = d.indicators.find(
    (i) => (i.kind === "correlation" || i.kind === "spread") && i.market === undefined
  );
  if (unpaired) {
    return fail(
      unpaired.kind === "correlation"
        ? `indicator "${unpaired.id}": correlation needs the "market" to correlate with`
        : `indicator "${unpaired.id}": spread needs the "market" to measure the traded coin against`
    );
  }
  const foreign = d.indicators.find((i) => i.market !== undefined && !isFleetInstrument(i.market));
  if (foreign) {
    return fail(
      `indicator "${foreign.id}": market "${foreign.market}" must be one of ${MARKET_LIST}`
    );
  }
  const kinds = new Map(d.indicators.map((i) => [i.id, i.kind]));

  const long = ConditionSchema.safeParse(d.longEntry);
  if (!long.success) return fail(zodMessage(long.error, "longEntry."));
  const short = ConditionSchema.safeParse(d.shortEntry);
  if (!short.success) return fail(zodMessage(short.error, "shortEntry."));
  const exitOf = (raw: unknown, where: string) => {
    if (raw === undefined || raw === null) return { ok: true as const, data: undefined };
    const parsed = ConditionSchema.safeParse(raw);
    return parsed.success
      ? { ok: true as const, data: parsed.data }
      : { ok: false as const, error: zodMessage(parsed.error, `${where}.`) };
  };
  const longExit = exitOf(d.longExit, "longExit");
  if (!longExit.ok) return fail(longExit.error);
  const shortExit = exitOf(d.shortExit, "shortExit");
  if (!shortExit.ok) return fail(shortExit.error);
  const problems = [
    ...conditionProblems(long.data, kinds, "longEntry"),
    ...conditionProblems(short.data, kinds, "shortEntry"),
    ...(longExit.data ? conditionProblems(longExit.data, kinds, "longExit") : []),
    ...(shortExit.data ? conditionProblems(shortExit.data, kinds, "shortExit") : [])
  ];
  if (problems.length > 0) return fail(problems.slice(0, 4).join("; "));

  const instruments: readonly string[] = brief.instruments;
  const instrumentId: FleetInstrument = instruments.includes(d.instrumentId)
    ? (d.instrumentId as FleetInstrument)
    : (brief.instruments[0] ?? FLEET_INSTRUMENTS[0]);
  // A pair holds its second coin against the first and trades nothing else
  let pairWith: FleetInstrument | null = null;
  if (d.pairWith !== undefined && d.pairWith !== null) {
    if (!isFleetInstrument(d.pairWith) || !instruments.includes(d.pairWith)) {
      return fail(`pairWith: "${d.pairWith}" must be one of ${brief.instruments.join(", ")}`);
    }
    if (d.pairWith === instrumentId)
      return fail("pairWith must be a different coin from instrumentId");
    if ((d.basket ?? []).length > 0)
      return fail("a pair trades its two coins only: leave basket empty");
    if (!JSON.stringify([d.indicators, d.longEntry, d.shortEntry]).includes(`"${d.pairWith}"`)) {
      return fail(
        `a pair's entry rules must read its other coin: give an indicator "market": "${d.pairWith}" (a spread, say)`
      );
    }
    pairWith = d.pairWith as FleetInstrument;
  }
  // The basket keeps only coins the brief allows, after the boat's own market
  const basket = pairWith
    ? []
    : rigMarkets({
        instrumentId,
        basket: (d.basket ?? []).filter((m): m is FleetInstrument => instruments.includes(m))
      }).slice(1);
  const direction = brief.direction === "any" ? d.direction : brief.direction;
  const indicators = d.indicators.map((i) => ({
    id: i.id,
    kind: i.kind,
    period: clamp(i.period, 2, 200, true),
    ...(i.market ? { market: i.market as FleetInstrument } : {}),
    ...(i.timeframe ? { timeframe: i.timeframe } : {})
  }));
  const periods = indicators.map((i) => i.period);
  const lookbackPeriod = clamp(Math.max(...periods), 5, 200, true);
  const fastPeriod = clamp(Math.min(...periods, lookbackPeriod - 2), 3, 100, true);
  const stopAtrMultiple = clamp(d.stopAtrMultiple, 0.5, 6);
  const rewardMultiple = clamp(d.rewardMultiple, 0.8, 6);
  const trailingAtrMultiple =
    pairWith || d.trailingAtrMultiple === null || d.trailingAtrMultiple === undefined
      ? null
      : clamp(d.trailingAtrMultiple, 0.5, 6);
  // A pair always has a time limit, as a pair rig does
  const maxBarsHeld =
    d.maxBarsHeld === null || d.maxBarsHeld === undefined
      ? pairWith
        ? Math.min(240, lookbackPeriod * 3)
        : null
      : clamp(d.maxBarsHeld, 2, 240, true);

  const invention: Invention = {
    indicators,
    longEntry: long.data,
    shortEntry: short.data,
    ...(longExit.data ? { longExit: longExit.data } : {}),
    ...(shortExit.data ? { shortExit: shortExit.data } : {}),
    rules: []
  };
  const rig = RigSchema.parse({
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
    basket,
    trailingAtrMultiple,
    maxBarsHeld,
    pairWith,
    invention: {
      ...invention,
      rules: describeInvention(
        {
          direction,
          stopAtrMultiple,
          rewardMultiple,
          instrumentId,
          basket,
          trailingAtrMultiple,
          maxBarsHeld,
          pairWith
        },
        invention
      )
    }
  });

  try {
    compileRig(rig, "invention_check");
    if (pairWith) compileRig(rig, "invention_check", 1);
  } catch (err) {
    if (err instanceof z.ZodError) return fail(zodMessage(err));
    return fail(err instanceof Error ? err.message : String(err));
  }
  return { ok: true, rig };
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
  if (asked !== check.rig.instrumentId) {
    return {
      ok: false,
      name: check.rig.name,
      error: `instrumentId must be one of ${MARKET_LIST}`
    };
  }
  const basket =
    typeof raw === "object" && raw !== null && "basket" in raw
      ? (raw as { basket: unknown }).basket
      : undefined;
  if (Array.isArray(basket)) {
    const unknown = basket.find((m) => typeof m !== "string" || !isFleetInstrument(m));
    if (unknown !== undefined) {
      return {
        ok: false,
        name: check.rig.name,
        error: `basket: "${String(unknown)}" must be one of ${MARKET_LIST}`
      };
    }
    if (new Set([check.rig.instrumentId, ...basket]).size > MAX_BOAT_MARKETS) {
      return {
        ok: false,
        name: check.rig.name,
        error: `a boat trades at most ${MAX_BOAT_MARKETS} coins: instrumentId plus up to ${MAX_BOAT_MARKETS - 1} in basket`
      };
    }
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
      error: 'Expected {"propositions": [...]} with at least one design in it.'
    };
  }
  if (list.length > MAX_IMPORTED_INVENTIONS) {
    return {
      ok: false,
      error: `The file holds ${list.length} designs; import at most ${MAX_IMPORTED_INVENTIONS} at a time.`
    };
  }
  return { ok: true, inventions: list };
}
