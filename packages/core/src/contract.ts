import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { ExecutionModeSchema } from "./config.js";

const c = initContract();

export const SystemStatusResponseSchema = z.object({
  appName: z.literal("Keel"),
  version: z.string(),
  executionMode: ExecutionModeSchema,
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  serverTimeMs: z.number().int(),
  serverTimeIso: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  cloudflareTunnelActive: z.boolean(),
  clientIp: z.string(),
  status: z.literal("ok")
});

export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>;

export const keelApiContract = c.router({
  system: {
    getStatus: {
      method: "GET",
      path: "/api/v1/system/status",
      responses: {
        200: SystemStatusResponseSchema
      },
      summary: "Get Keel system health, execution mode, and config hash"
    }
  }
});
