import { describe, expect, it } from "vitest";
import {
  ManualClock,
  createDefaultConfig,
  normalizeRig,
  type RigDraft,
  type DesignBrief
} from "@keel/core";
import type Anthropic from "@anthropic-ai/sdk";
import {
  BotDesigner,
  ClaudeLlmGateway,
  type ClaudeMessagesClient,
  type InventionChecker
} from "../src/index.js";

const BRIEF: DesignBrief = {
  instruments: ["ETH-USDT-SWAP"],
  direction: "long_only",
  count: 2,
  notes: "something that rides strong moves"
};

const DRAFT: RigDraft = {
  name: "Trade Wind",
  tagline: "Rides the impulse.",
  archetype: "momentum",
  instrumentId: "BTC-USDT-SWAP",
  direction: "both",
  lookbackPeriod: 12,
  fastPeriod: 6,
  entryThreshold: 1,
  stopAtrMultiple: 1.5,
  rewardMultiple: 3,
  rationale: "Impulses persist."
};

describe("Bot designer: the Shipwright", () => {
  /** A stand-in for @keel/spec's checker: anything named "Broken…" fails with a fixed reason. */
  const checkInvention: InventionChecker = (raw) => {
    const name =
      typeof raw === "object" && raw !== null && "name" in raw ? String(raw.name) : "(unnamed)";
    if (name.startsWith("Broken")) {
      return { ok: false, name, error: 'longEntry: no indicator has id "rsii"' };
    }
    return { ok: true, rig: { ...normalizeRig(DRAFT), name, archetype: "invented" } };
  };

  function shipwrightWith(replies: unknown[], apiKey: string | null = "sk-ant-test") {
    const calls: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
    const client: ClaudeMessagesClient = {
      create: (params) => {
        calls.push(params);
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
        return Promise.resolve({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: params.model,
          content: [
            { type: "text", text: `Here you go:\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` }
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3000, output_tokens: 2500 }
        } as unknown as Anthropic.Beta.Messages.BetaMessage);
      }
    };
    const clock = new ManualClock(1_793_000_000_000);
    const gateway = new ClaudeLlmGateway({
      clock,
      getConfig: () => ({ ...createDefaultConfig().ai, dailyBudgetUsd: 5 }),
      getApiKey: () => apiKey,
      createClient: () => client
    });
    const designer = new BotDesigner({
      clock,
      gateway,
      isLive: () => gateway.hasApiKey(),
      checkInvention
    });
    return { designer, calls };
  }

  it("asks Claude to think deeply and accepts fenced JSON", async () => {
    const { designer, calls } = shipwrightWith([
      { propositions: [{ name: "Night Watch" }, { name: "Slack Water" }] }
    ]);
    const result = await designer.design(BRIEF, []);
    expect(result.rigs.map((b) => b.name)).toEqual(["Night Watch", "Slack Water"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.thinking).toEqual({ type: "adaptive" });
    expect(calls[0]?.output_config?.effort).toBe("high");
    expect(calls[0]?.output_config?.format).toBeUndefined();
  });

  it("never reuses a name already in the fleet or the batch", async () => {
    const { designer } = shipwrightWith([
      { propositions: [{ name: "Trade Wind" }, { name: "Trade Wind" }] }
    ]);
    const result = await designer.design(BRIEF, ["Trade Wind"]);
    expect(result.rigs.map((b) => b.name)).toEqual(["Trade Wind II", "Trade Wind III"]);
  });

  it("sends a failed invention back once with Keel's exact complaint", async () => {
    const { designer, calls } = shipwrightWith([
      { propositions: [{ name: "Night Watch" }, { name: "Broken Compass" }] },
      { propositions: [{ name: "True Compass" }] }
    ]);
    const result = await designer.design(BRIEF, []);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.messages)).toContain('no indicator has id \\\\\\"rsii');
    expect(result.rigs.map((b) => b.name)).toEqual(["Night Watch", "True Compass"]);
    expect(result.note).toBeNull();
  });

  it("drops what still fails after the repair, and says so", async () => {
    const { designer } = shipwrightWith([
      { propositions: [{ name: "Night Watch" }, { name: "Broken Compass" }] },
      { propositions: [{ name: "Broken Again" }] }
    ]);
    const result = await designer.design(BRIEF, []);
    expect(result.rigs.map((b) => b.name)).toEqual(["Night Watch"]);
    expect(result.note).toMatch(/1 design still broke Keel's rule limits.*Broken Again/);
  });

  it("refuses to pretend when nothing Claude invented passes", async () => {
    const { designer } = shipwrightWith([{ propositions: [{ name: "Broken Compass" }] }]);
    await expect(designer.design({ ...BRIEF, count: 1 } as DesignBrief, [])).rejects.toThrow(
      /None of the Shipwright's designs passed Keel's checks/
    );
  });

  it("offers Keel's own sample inventions when Claude is not linked", async () => {
    const { designer, calls } = shipwrightWith([], null);
    const result = await designer.design(BRIEF, []);
    expect(calls).toHaveLength(0);
    expect(result.source).toBe("sample");
    expect(result.note).toMatch(/sample designs/);
    expect(result.rigs.map((b) => b.name)).toEqual(["Night Watch", "Tidal Snapback"]);
  });
});
