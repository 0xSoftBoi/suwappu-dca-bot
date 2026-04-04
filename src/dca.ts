import cron from "node-cron";
import { createClient, type SuwappuClient } from "@suwappu/sdk";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface DCAPlan {
  id: string;
  name: string;
  fromToken: string;
  toToken: string;
  amount: number;
  chain: string;
  schedule: string;
  enabled?: boolean;
}

export interface ExecutionEntry {
  timestamp: string;
  planId: string;
  fromToken: string;
  toToken: string;
  amount: number;
  chain: string;
  success: boolean;
  txHash?: string;
  error?: string;
}

const HISTORY_PATH = join(homedir(), ".suwappu-dca", "history.json");

export class DCAEngine {
  private client: SuwappuClient;
  private plans: DCAPlan[] = [];
  private tasks: cron.ScheduledTask[] = [];

  constructor(apiKey: string) {
    this.client = createClient({ apiKey });
  }

  addPlan(plan: DCAPlan): void {
    this.plans.push(plan);
  }

  start(): void {
    for (const plan of this.plans) {
      if (plan.enabled === false) continue;

      if (!cron.validate(plan.schedule)) {
        console.error(`Invalid cron schedule for "${plan.name}": ${plan.schedule}`);
        continue;
      }

      // Simple check: reject "* * * * *" patterns (every minute)
      if (plan.schedule.startsWith('* ') || plan.schedule === '* * * * *') {
        console.error(`Schedule ${plan.schedule} runs too frequently. Minimum interval is 5 minutes.`);
        continue;
      }

      const MAX_DCA_AMOUNT = parseFloat(process.env.SUWAPPU_MAX_TRADE_USD || '1000');
      if (plan.amount <= 0 || plan.amount > MAX_DCA_AMOUNT) {
        console.error(`Plan amount ${plan.amount} invalid. Must be > 0 and <= ${MAX_DCA_AMOUNT}`);
        continue;
      }

      const task = cron.schedule(plan.schedule, async () => {
        console.log(`[${new Date().toISOString()}] Executing: ${plan.name}`);
        const result = await this.executeBuy(plan);
        if (result.success) {
          console.log(`  ✓ Bought ${plan.toToken} for $${plan.amount} — TX: ${result.txHash}`);
        } else {
          console.log(`  ✗ Failed: ${result.error}`);
        }
      });

      this.tasks.push(task);
    }
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
  }

  async executeBuy(plan: DCAPlan): Promise<ExecutionEntry> {
    const entry: ExecutionEntry = {
      timestamp: new Date().toISOString(),
      planId: plan.id,
      fromToken: plan.fromToken,
      toToken: plan.toToken,
      amount: plan.amount,
      chain: plan.chain,
      success: false,
    };

    try {
      const quote = await this.client.getQuote(
        plan.fromToken,
        plan.toToken,
        plan.amount,
        plan.chain
      );

      const tx = await this.client.executeSwap(quote.id);
      entry.success = true;
      entry.txHash = tx.txHash;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }

    this.appendHistory(entry);
    return entry;
  }

  getHistory(): ExecutionEntry[] {
    if (!existsSync(HISTORY_PATH)) return [];
    const raw = readFileSync(HISTORY_PATH, "utf-8");
    return JSON.parse(raw) as ExecutionEntry[];
  }

  private appendHistory(entry: ExecutionEntry): void {
    const history = this.getHistory();
    history.push(entry);

    const dir = join(homedir(), ".suwappu-dca");
    if (!existsSync(dir)) {
      const { mkdirSync } = require("fs");
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  }
}
