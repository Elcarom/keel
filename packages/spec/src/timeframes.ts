import { z } from "zod";

/** Higher timeframes, built from complete confirmed 1H bars (ADR-0031). */
export const HigherTimeframeSchema = z.enum(["4H", "1D"]);
export type HigherTimeframe = z.infer<typeof HigherTimeframeSchema>;
export const TIMEFRAME_HOURS: Readonly<Record<HigherTimeframe | "1H", number>> = {
  "1H": 1,
  "4H": 4,
  "1D": 24
};
