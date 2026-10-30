import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import {
  type AiGatewayConfig,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  type LlmGateway
} from "@keel/core";
import { z } from "zod";

// ============================================================================
// Claude through the operator's own subscription (ADR-0033): Keel runs the official Claude Code
// CLI headless, signed in with a long-lived token from `claude setup-token`. No API key, no tools,
// no session kept; the prompt goes in on stdin and one JSON result comes back.
// ============================================================================

export interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI once; injectable so tests never start a process. */
export type CliRunner = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
}) => Promise<CliRun>;

export interface ClaudeCodeGatewayOptions {
  readonly getConfig: () => AiGatewayConfig;
  /** The `claude setup-token` token; null when the operator has not linked a subscription. */
  readonly getToken: () => string | null;
  /** Where the CLI keeps its own state, away from any operator settings. */
  readonly homeDir: string;
  readonly command?: string | undefined;
  readonly run?: CliRunner | undefined;
  /** A sea of thought can take a while; past this the call is abandoned. */
  readonly timeoutMs?: number | undefined;
}

/** The fields of the CLI's `--output-format json` result that Keel reads. */
const CliResultSchema = z.object({
  is_error: z.boolean(),
  subtype: z.string(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional()
});

const DEFAULT_TIMEOUT_MS = 20 * 60_000;

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

const spawnCli: CliRunner = (input) =>
  new Promise((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input.stdin, "utf8");
  });

/**
 * LLM Gateway adapter that reaches Claude through the Claude Code CLI on the operator's
 * subscription. The subscription is not billed per call, so no spend is recorded; the night
 * shift's schedule is what keeps usage within the plan's limits.
 */
export class ClaudeCodeLlmGateway implements LlmGateway {
  private readonly getConfig: () => AiGatewayConfig;
  private readonly getToken: () => string | null;
  private readonly homeDir: string;
  private readonly command: string;
  private readonly run: CliRunner;
  private readonly timeoutMs: number;

  public constructor(options: ClaudeCodeGatewayOptions) {
    this.getConfig = options.getConfig;
    this.getToken = options.getToken;
    this.homeDir = options.homeDir;
    this.command = options.command ?? "claude";
    this.run = options.run ?? spawnCli;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public hasToken(): boolean {
    return this.getToken() !== null;
  }

  public getRemainingDailyBudgetUsd(): number {
    return this.getConfig().dailyBudgetUsd;
  }

  public getRemainingMonthlyBudgetUsd(): number {
    return this.getConfig().monthlyBudgetUsd;
  }

  public async completeStructured<T>(
    request: LlmCompletionRequest,
    schema: z.ZodType<T>
  ): Promise<LlmCompletionResponse<T>> {
    const token = this.getToken();
    if (!token) throw new Error("No Claude subscription is linked");
    const config = this.getConfig();

    const args = [
      "-p",
      "--output-format",
      "json",
      // Claude only writes an answer here: no tools, MCP servers or saved session
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model",
      config.botDesignerModel,
      "--effort",
      request.reasoning === "deep" ? "high" : "medium",
      "--system-prompt",
      request.systemPrompt,
      ...(request.outputJsonSchema
        ? ["--json-schema", JSON.stringify(request.outputJsonSchema)]
        : [])
    ];
    mkdirSync(this.homeDir, { recursive: true });
    // Only what the CLI needs: an API key in the environment would bill the API instead
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: this.homeDir,
      CLAUDE_CODE_OAUTH_TOKEN: token,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    };

    let run: CliRun;
    try {
      run = await this.run({
        command: this.command,
        args,
        stdin: request.userPrompt,
        env,
        cwd: this.homeDir,
        timeoutMs: this.timeoutMs
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not start Claude Code (${message}); is the claude CLI installed?`);
    }

    let parsedRun: z.infer<typeof CliResultSchema>;
    try {
      parsedRun = CliResultSchema.parse(JSON.parse(run.stdout));
    } catch {
      const detail = (run.stderr || run.stdout).trim().slice(0, 300);
      throw new Error(
        run.code === null
          ? "Claude Code took too long and was stopped"
          : `Claude Code failed (exit ${run.code})${detail ? `: ${detail}` : ""}`
      );
    }
    if (parsedRun.is_error) {
      throw new Error(
        `Claude Code could not finish${parsedRun.subtype === "success" ? "" : ` (${parsedRun.subtype})`}${parsedRun.result ? `: ${parsedRun.result.slice(0, 300)}` : ""}`
      );
    }

    const rawText = parsedRun.result ?? "";
    const value =
      request.outputJsonSchema && parsedRun.structured_output !== undefined
        ? parsedRun.structured_output
        : (JSON.parse(extractJsonObject(rawText)) as unknown);
    const cutoffTs = Date.parse(
      `${request.modelCutoffDate ?? config.trainingCutoffDate}T00:00:00.000Z`
    );
    return {
      parsed: schema.parse(value),
      rawText,
      promptTokens: parsedRun.usage?.input_tokens ?? 0,
      completionTokens: parsedRun.usage?.output_tokens ?? 0,
      actualCostUsd: 0,
      trainingContaminated: request.asOfMs < cutoffTs
    };
  }
}
