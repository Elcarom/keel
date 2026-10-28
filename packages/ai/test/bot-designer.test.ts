import { describe, expect, it } from "vitest";
import {
  ManualClock,
  createDefaultConfig,
  normalizeBlueprint,
  type BotBlueprintDraft,
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
  mode: "blueprint",
  instruments: ["ETH-USDT-SWAP"],
  styles: ["momentum"],
  riskAppetite: "bold",
  direction: "long_only",
  count: 2,
  notes: "something that rides strong moves"
};

const DRAFT: BotBlueprintDraft = {
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

function fakeClaude(
  reply: { propositions: BotBlueprintDraft[] },
  stopReason: Anthropic.Beta.Messages.BetaStopReason = "end_turn"
) {
  const calls: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const client: ClaudeMessagesClient = {
    create: (params) => {
      calls.push(params);
      const message = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: params.model,
        content: [{ type: "text", text: JSON.stringify(reply), citations: null }],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 900 }
      } as unknown as Anthropic.Beta.Messages.BetaMessage;
      return Promise.resolve(message);
    }
  };
  return { client, calls };
}

function designerWith(client: ClaudeMessagesClient, apiKey: string | null = "sk-ant-test") {
  const clock = new ManualClock(1_793_000_000_000);
  const config = createDefaultConfig();
  const gateway = new ClaudeLlmGateway({
    clock,
    getConfig: () => ({ ...config.ai, dailyBudgetUsd: 5 }),
    getApiKey: () => apiKey,
    createClient: () => client
  });
  return new BotDesigner({ clock, gateway, isLive: () => gateway.hasApiKey() });
}

describe("Bot designer", () => {
  it("asks Claude for schema-constrained propositions with the configured model", async () => {
    const { client, calls } = fakeClaude({
      propositions: [DRAFT, { ...DRAFT, name: "Spinnaker" }]
    });
    const result = await designerWith(client).design(BRIEF, []);
    expect(result.source).toBe("claude");
    expect(result.note).toBeNull();
    const params = calls[0];
    expect(params?.model).toBe("claude-opus-5-5");
    expect(params?.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(params?.messages)).toContain("rides strong moves");
  });

  it("enforces the brief's instruments and direction whatever the model answers", async () => {
    const { client } = fakeClaude({ propositions: [DRAFT, { ...DRAFT, name: "Spinnaker" }] });
    const result = await designerWith(client).design(BRIEF, []);
    for (const b of result.blueprints) {
      expect(b.instrumentId).toBe("ETH-USDT-SWAP");
      expect(b.direction).toBe("long_only");
    }
  });

  it("never reuses a name already in the fleet or the batch", async () => {
    const { client } = fakeClaude({ propositions: [DRAFT, DRAFT, DRAFT] });
    const result = await designerWith(client).design({ ...BRIEF, count: 3 }, ["Trade Wind"]);
    expect(result.blueprints.map((b) => b.name)).toEqual([
      "Trade Wind II",
      "Trade Wind III",
      "Trade Wind IV"
    ]);
  });

  it("drafts sample propositions, and says so, when no Anthropic key is set", async () => {
    const { client, calls } = fakeClaude({ propositions: [DRAFT] });
    const result = await designerWith(client, null).design({ ...BRIEF, count: 3 }, []);
    expect(calls).toHaveLength(0);
    expect(result.source).toBe("sample");
    expect(result.note).toMatch(/sample propositions/);
    expect(result.blueprints).toHaveLength(3);
    expect(result.blueprints.every((b) => b.archetype === "momentum")).toBe(true);
  });

  it("surfaces a refusal instead of inventing propositions", async () => {
    const { client } = fakeClaude({ propositions: [DRAFT] }, "refusal");
    await expect(designerWith(client).design(BRIEF, [])).rejects.toThrow(/declined/);
  });
});

describe("Inventor mode", () => {
  const INVENTOR_BRIEF: DesignBrief = { ...BRIEF, mode: "inventor", count: 2 };

  /** A stand-in for @keel/spec's checker: anything named "Broken…" fails with a fixed reason. */
  const checkInvention: InventionChecker = (raw) => {
    const name =
      typeof raw === "object" && raw !== null && "name" in raw ? String(raw.name) : "(unnamed)";
    if (name.startsWith("Broken")) {
      return { ok: false, name, error: 'longEntry: no indicator has id "rsii"' };
    }
    return { ok: true, blueprint: { ...normalizeBlueprint(DRAFT), name, archetype: "invented" } };
  };

  function inventorWith(replies: unknown[], apiKey: string | null = "sk-ant-test") {
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
    const { designer, calls } = inventorWith([
      { propositions: [{ name: "Night Watch" }, { name: "Slack Water" }] }
    ]);
    const result = await designer.design(INVENTOR_BRIEF, []);
    expect(result.blueprints.map((b) => b.name)).toEqual(["Night Watch", "Slack Water"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.thinking).toEqual({ type: "adaptive" });
    expect(calls[0]?.output_config?.effort).toBe("high");
    expect(calls[0]?.output_config?.format).toBeUndefined();
  });

  it("sends a failed invention back once with Keel's exact complaint", async () => {
    const { designer, calls } = inventorWith([
      { propositions: [{ name: "Night Watch" }, { name: "Broken Compass" }] },
      { propositions: [{ name: "True Compass" }] }
    ]);
    const result = await designer.design(INVENTOR_BRIEF, []);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.messages)).toContain('no indicator has id \\\\\\"rsii');
    expect(result.blueprints.map((b) => b.name)).toEqual(["Night Watch", "True Compass"]);
    expect(result.note).toBeNull();
  });

  it("drops what still fails after the repair, and says so", async () => {
    const { designer } = inventorWith([
      { propositions: [{ name: "Night Watch" }, { name: "Broken Compass" }] },
      { propositions: [{ name: "Broken Again" }] }
    ]);
    const result = await designer.design(INVENTOR_BRIEF, []);
    expect(result.blueprints.map((b) => b.name)).toEqual(["Night Watch"]);
    expect(result.note).toMatch(/1 invention still broke Keel's rule limits.*Broken Again/);
  });

  it("refuses to pretend when nothing Claude invented passes", async () => {
    const { designer } = inventorWith([{ propositions: [{ name: "Broken Compass" }] }]);
    await expect(
      designer.design({ ...INVENTOR_BRIEF, count: 1 } as DesignBrief, [])
    ).rejects.toThrow(/None of Claude's inventions passed Keel's checks/);
  });

  it("offers Keel's own sample inventions when no Anthropic key is set", async () => {
    const { designer, calls } = inventorWith([], null);
    const result = await designer.design(INVENTOR_BRIEF, []);
    expect(calls).toHaveLength(0);
    expect(result.source).toBe("sample");
    expect(result.note).toMatch(/sample inventions/);
    expect(result.blueprints.map((b) => b.name)).toEqual(["Night Watch", "Tidal Snapback"]);
  });
});
