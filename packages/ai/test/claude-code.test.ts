import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "@keel/core";
import { z } from "zod";
import { ClaudeCodeLlmGateway, type CliRunner } from "../src/claude-code.js";

const REQUEST = {
  featureName: "strategyLab" as const,
  systemPrompt: "You design boats.",
  userPrompt: '{"request":"Propose 2 boats."}',
  asOfMs: Date.UTC(2026, 9, 30),
  outputJsonSchema: { type: "object" },
  reasoning: "deep" as const
};
const Answer = z.object({ ok: z.boolean() });

function gateway(run: CliRunner, token: string | null = "sk-ant-oat01-test") {
  return new ClaudeCodeLlmGateway({
    getConfig: () => createDefaultConfig().ai,
    getToken: () => token,
    homeDir: mkdtempSync(join(tmpdir(), "keel-cc-")),
    run
  });
}

function result(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", is_error: false, subtype: "success", ...fields });
}

describe("Claude through the operator's subscription", () => {
  it("asks the Claude Code CLI with no tools, signed in only with the subscription token", async () => {
    const seen: Parameters<CliRunner>[0][] = [];
    const answer = await gateway((input) => {
      seen.push(input);
      return Promise.resolve({
        code: 0,
        stdout: result({ result: '{"ok":true}', structured_output: { ok: true } }),
        stderr: ""
      });
    }).completeStructured(REQUEST, Answer);

    expect(answer.parsed).toEqual({ ok: true });
    // A subscription is not billed per call
    expect(answer.actualCostUsd).toBe(0);
    const call = seen[0];
    expect(call?.stdin).toBe(REQUEST.userPrompt);
    expect(call?.args).toEqual(
      expect.arrayContaining(["-p", "--output-format", "json", "--no-session-persistence"])
    );
    const args = call?.args ?? [];
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(REQUEST.systemPrompt);
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(call?.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-test");
    // An API key in the environment would bill the API instead of the subscription
    expect(Object.keys(call?.env ?? {})).not.toContain("ANTHROPIC_API_KEY");
  });

  it("reads JSON from the answer's text when no schema constrained it", async () => {
    const answer = await gateway(() =>
      Promise.resolve({
        code: 0,
        stdout: result({ result: 'Here you go:\n```json\n{"ok":false}\n```' }),
        stderr: ""
      })
    ).completeStructured({ ...REQUEST, outputJsonSchema: undefined }, Answer);
    expect(answer.parsed).toEqual({ ok: false });
  });

  it("says why when the CLI fails, is missing, or the subscription is not linked", async () => {
    await expect(
      gateway(() =>
        Promise.resolve({
          code: 1,
          stdout: result({
            is_error: true,
            subtype: "error_during_execution",
            result: "Invalid API key · Please run /login"
          }),
          stderr: ""
        })
      ).completeStructured(REQUEST, Answer)
    ).rejects.toThrow(/could not finish \(error_during_execution\): Invalid API key/);

    await expect(
      gateway(() =>
        Promise.resolve({ code: 127, stdout: "", stderr: "claude: not found" })
      ).completeStructured(REQUEST, Answer)
    ).rejects.toThrow("Claude Code failed (exit 127): claude: not found");

    await expect(
      gateway(() => Promise.reject(new Error("spawn claude ENOENT"))).completeStructured(
        REQUEST,
        Answer
      )
    ).rejects.toThrow(/is the claude CLI installed/);

    await expect(
      gateway(() => Promise.reject(new Error("never called")), null).completeStructured(
        REQUEST,
        Answer
      )
    ).rejects.toThrow("No Claude subscription is linked");
  });
});
