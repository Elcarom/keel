import type { Clock } from "@keel/core";
import { TotpEngine, type createKeelServer } from "../src/index.js";

type KeelApp = Awaited<ReturnType<typeof createKeelServer>>;

/** Enrols the bootstrap TOTP secret so real-money (Gate G3) paths are reachable in a test. */
export async function enrollTotp(
  app: KeelApp,
  cookie: string,
  totpSecretBase32: string,
  clock: Clock
): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/totp/verify",
    headers: { cookie },
    payload: { code: TotpEngine.generateCode(totpSecretBase32, clock.nowMs()) }
  });
  if (res.statusCode !== 200) {
    throw new Error(`TOTP enrolment failed: ${res.statusCode} ${res.body}`);
  }
}
