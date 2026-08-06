import cron from "node-cron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ExecutionMode } from "./execution.js";
import {
  executeManagedSwap,
  getQuote,
  simulateSwap,
} from "./suwappu.js";

export interface DCAPlan {
  id: string;
  name: string;
  fromToken: string;
  toToken: string;
  amount: number;
  chain: string;
  schedule: string;
  timezone?: string;
  enabled?: boolean;
}

export type ExecutionOutcome = "preview" | "submitted" | "failed";

export interface ExecutionEntry {
  timestamp: string;
  planId: string;
  fromToken: string;
  toToken: string;
  amount: number;
  chain: string;
  outcome: ExecutionOutcome;
  quoteId?: string;
  toAmount?: string;
  swapId?: string;
  txHash?: string;
  error?: string;
}

const HISTORY_PATH = join(homedir(), ".suwappu-dca", "history.json");

export class DCAEngine {
  private readonly plans: DCAPlan[] = [];
  private readonly tasks: cron.ScheduledTask[] = [];
  private readonly runningPlans = new Set<string>();

  constructor(
    private readonly apiKey: string,
    private readonly mode: ExecutionMode = { kind: "preview" },
  ) {}

  addPlan(plan: DCAPlan): void {
    if (this.plans.some((existing) => existing.id === plan.id)) {
      throw new Error(`Duplicate DCA plan id: ${plan.id}`);
    }
    this.plans.push(plan);
  }

  start(): void {
    for (const plan of this.plans) {
      if (plan.enabled === false) continue;

      if (!cron.validate(plan.schedule)) {
        console.error(`Invalid cron schedule for "${plan.name}": ${plan.schedule}`);
        continue;
      }

      if (plan.schedule.trim() === "* * * * *") {
        console.error(
          `Schedule for "${plan.name}" runs every minute and is disabled by this example.`,
        );
        continue;
      }

      if (!Number.isFinite(plan.amount) || plan.amount <= 0) {
        console.error(`Plan amount for "${plan.name}" must be a positive source-token amount.`);
        continue;
      }

      if (plan.timezone) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: plan.timezone }).format();
        } catch {
          console.error(`Invalid IANA timezone for "${plan.name}": ${plan.timezone}`);
          continue;
        }
      }

      const task = cron.schedule(plan.schedule, async () => {
        if (this.runningPlans.has(plan.id)) {
          console.warn(
            `[${new Date().toISOString()}] Skipping overlapping run: ${plan.name}`,
          );
          return;
        }

        this.runningPlans.add(plan.id);
        try {
          console.log(`[${new Date().toISOString()}] DCA trigger: ${plan.name}`);
          const result = await this.executeBuy(plan);
          if (result.outcome === "preview") {
            console.log(
              `  Preview: ${plan.amount} ${plan.fromToken} → ${result.toAmount ?? "?"} ${plan.toToken}`,
            );
          } else if (result.outcome === "submitted") {
            console.log(
              `  Submitted: swap ${result.swapId ?? "unknown"} | TX: ${result.txHash ?? "pending"}`,
            );
          } else {
            console.log(`  Failed: ${result.error}`);
          }
        } finally {
          this.runningPlans.delete(plan.id);
        }
      }, plan.timezone ? { timezone: plan.timezone } : {});

      this.tasks.push(task);
    }
  }

  stop(): void {
    for (const task of this.tasks) task.stop();
    this.tasks.length = 0;
  }

  async executeBuy(plan: DCAPlan): Promise<ExecutionEntry> {
    const entry: ExecutionEntry = {
      timestamp: new Date().toISOString(),
      planId: plan.id,
      fromToken: plan.fromToken,
      toToken: plan.toToken,
      amount: plan.amount,
      chain: plan.chain,
      outcome: "failed",
    };

    try {
      if (!Number.isFinite(plan.amount) || plan.amount <= 0) {
        throw new Error("DCA amount must be a positive source-token amount");
      }

      const quote = await getQuote(this.apiKey, {
        from: plan.fromToken,
        to: plan.toToken,
        amount: plan.amount,
        chain: plan.chain,
        ...(this.mode.kind === "managed"
          ? { walletAddress: this.mode.walletAddress }
          : {}),
      });
      entry.quoteId = quote.id;
      entry.toAmount = quote.toAmount;

      if (this.mode.kind === "preview") {
        entry.outcome = "preview";
      } else {
        const simulation = await simulateSwap(
          this.apiKey,
          quote.id,
          this.mode.walletAddress,
        );
        if (simulation.success !== true) {
          throw new Error(
            `Swap simulation failed: ${simulation.reason ?? "no success response"}`,
          );
        }

        const swap = await executeManagedSwap(this.apiKey, quote.id);
        entry.outcome = "submitted";
        entry.swapId = swap.swapId;
        entry.txHash = swap.txHash;
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }

    this.appendHistory(entry);
    return entry;
  }

  getHistory(): ExecutionEntry[] {
    if (!existsSync(HISTORY_PATH)) return [];

    const parsed = JSON.parse(readFileSync(HISTORY_PATH, "utf-8")) as Array<
      Partial<ExecutionEntry> & { success?: boolean }
    >;
    if (!Array.isArray(parsed)) return [];

    return parsed.map((entry) => ({
      ...entry,
      outcome:
        entry.outcome === "preview" ||
        entry.outcome === "submitted" ||
        entry.outcome === "failed"
          ? entry.outcome
          : entry.success
            ? "submitted"
            : "failed",
    })) as ExecutionEntry[];
  }

  private appendHistory(entry: ExecutionEntry): void {
    const history = this.getHistory();
    history.push(entry);

    const dir = join(homedir(), ".suwappu-dca");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  }
}
