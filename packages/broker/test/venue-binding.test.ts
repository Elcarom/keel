import { describe, expect, it } from "vitest";
import { ManualClock, type ExecutionMode } from "@keel/core";
import { OkxBroker, okxDemoVenueFor } from "../src/index.js";
import { createFakeOkx } from "./fake-okx.js";

describe("OKX venue follows the active Execution Mode (audit-3 H5)", () => {
  it("routes only Live-Ramp and Live to the real-money account", () => {
    const modes: ExecutionMode[] = ["Replay", "Paper", "Demo", "Live-Ramp", "Live"];
    expect(modes.map((m) => [m, okxDemoVenueFor(m)])).toEqual([
      ["Replay", true],
      ["Paper", true],
      ["Demo", true],
      ["Live-Ramp", false],
      ["Live", false]
    ]);
  });

  it("re-evaluates the venue on every request instead of freezing it at startup", async () => {
    const fake = createFakeOkx();
    let mode: ExecutionMode = "Demo";
    const broker = new OkxBroker({
      clock: new ManualClock(1_750_000_000_000),
      getCredentials: () => ({
        apiKey: "k",
        secretKey: "test-secret-key-32-bytes-long-super-secret",
        passphrase: "p"
      }),
      isDemo: () => okxDemoVenueFor(mode),
      fetchFn: fake.fetchFn
    });

    await broker.sendDmsHeartbeat();
    mode = "Live";
    await broker.sendDmsHeartbeat();

    const [demoBeat, liveBeat] = fake.calls("/api/v5/trade/cancel-all-after");
    expect(demoBeat?.headers["x-simulated-trading"]).toBe("1");
    expect(liveBeat?.headers["x-simulated-trading"]).toBeUndefined();
  });
});
