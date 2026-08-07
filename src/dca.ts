import cron from "node-cron";
import {
  DEFAULT_MAX_DCA_USDC,
  validatePlan,
  type DCAPlan,
} from "./config.js";
import {
  getBlockingExecution,
  listExecutionJournal,
  reconcileExecutionJournal,
  recordFailure,
  recordPreview,
  runManagedExecution,
  type EconomicTerms,
  type ExecutionIntent,
  type ExecutionMode,
  type QuoteForExecution,
} from "./execution.js";
import { getQuote, type QuoteResult } from "./suwappu.js";

const RECONCILE_INTERVAL_MS = 60_000;

function wallClockSlot(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}T${values.hour}${values.minute}`;
}

/** Same local wall-clock slot means one DCA economic action, including DST repeats. */
export function scheduledActionKey(plan: DCAPlan, date = new Date()): string {
  return `schedule.${wallClockSlot(date, plan.timezone)}`;
}

export function manualActionKey(): string {
  return `manual.${Date.now().toString(36)}.${crypto.randomUUID().slice(0, 8)}`;
}

function economicTerms(plan: DCAPlan): EconomicTerms {
  return {
    fromToken: "USDC",
    toToken: plan.toToken,
    amount: String(plan.amount),
    chain: plan.chain,
  };
}

async function qualifiedQuote(args: {
  apiKey: string;
  terms: EconomicTerms;
  maxGasUsd: number;
  walletAddress?: string;
}): Promise<QuoteForExecution> {
  const quote = await getQuote(args.apiKey, {
    from: args.terms.fromToken,
    to: args.terms.toToken,
    amount: args.terms.amount,
    chain: args.terms.chain,
    walletAddress: args.walletAddress,
  });
  return qualifyDcaQuote(quote, args.maxGasUsd);
}

export function qualifyDcaQuote(
  quote: QuoteResult,
  maxGasUsd: number,
  nowMs = Date.now(),
): QuoteForExecution {
  if (quote.estimatedGasUsd === null) {
    throw new Error("Quote is missing estimated_gas_usd; refusing DCA promotion");
  }
  if (quote.estimatedGasUsd > maxGasUsd) {
    throw new Error(
      `Estimated gas $${quote.estimatedGasUsd.toFixed(2)} exceeds plan maxGasUsd=$${maxGasUsd.toFixed(2)}`,
    );
  }
  if (quote.expiresAtMs <= nowMs + 5_000) {
    throw new Error("Quote has 5 seconds or less remaining; refusing DCA promotion");
  }
  return {
    id: quote.id,
    toAmount: quote.toAmount,
    toAmountMin: quote.toAmountMin,
    estimatedGasUsd: quote.estimatedGasUsd,
    reportedRouteFeeUsd: quote.reportedRouteFeeUsd,
  };
}

export class DCAEngine {
  private readonly plans: DCAPlan[] = [];
  private readonly tasks: cron.ScheduledTask[] = [];
  private readonly runningPlans = new Set<string>();
  private recoveryTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly apiKey: string,
    private readonly mode: ExecutionMode = { kind: "preview" },
  ) {}

  addPlan(input: DCAPlan): void {
    const plan = validatePlan(
      input,
      `plan '${input.id || "unknown"}'`,
      process.env.SUWAPPU_MAX_DCA_USDC ?? DEFAULT_MAX_DCA_USDC,
    );
    if (this.plans.some((existing) => existing.id === plan.id)) {
      throw new Error(`Duplicate DCA plan id: ${plan.id}`);
    }
    this.plans.push(plan);
  }

  start(): void {
    // Validate durable state before registering any money-moving callbacks.
    listExecutionJournal(1);
    void reconcileExecutionJournal(this.apiKey).catch((error) => {
      console.error(`DCA reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.recoveryTimer = setInterval(() => {
      void reconcileExecutionJournal(this.apiKey).catch((error) => {
        console.error(`DCA reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, RECONCILE_INTERVAL_MS);

    for (const plan of this.plans) {
      if (!plan.enabled) continue;
      const task = cron.schedule(plan.schedule, async () => {
        if (this.runningPlans.has(plan.id)) {
          console.warn(`[${new Date().toISOString()}] Skipping overlapping callback: ${plan.name}`);
          return;
        }
        this.runningPlans.add(plan.id);
        const actionKey = scheduledActionKey(plan);
        try {
          console.log(`[${new Date().toISOString()}] DCA trigger: ${plan.name} (${actionKey})`);
          const result = await this.executeBuy(plan, actionKey);
          this.printResult(plan, result, actionKey);
        } catch (error) {
          console.error(
            `[${new Date().toISOString()}] DCA ${plan.name} failed closed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          this.runningPlans.delete(plan.id);
        }
      }, { timezone: plan.timezone });
      this.tasks.push(task);
    }
  }

  stop(): void {
    for (const task of this.tasks) task.stop();
    this.tasks.length = 0;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  async executeBuy(planInput: DCAPlan, actionKey = manualActionKey()): Promise<ExecutionIntent> {
    const plan = validatePlan(
      planInput,
      `plan '${planInput.id || "unknown"}'`,
      process.env.SUWAPPU_MAX_DCA_USDC ?? DEFAULT_MAX_DCA_USDC,
    );
    const terms = economicTerms(plan);

    if (this.mode.kind === "preview") {
      // An unreadable journal is an operational error even in preview; discovering
      // it before a future mode switch is much safer than silently resetting it.
      listExecutionJournal(1);
      try {
        const quote = await qualifiedQuote({
          apiKey: this.apiKey,
          terms,
          maxGasUsd: plan.maxGasUsd,
        });
        return recordPreview({
          planId: plan.id,
          actionKey,
          terms,
          maxGasUsd: plan.maxGasUsd,
          quote,
        });
      } catch (error) {
        return recordFailure({
          planId: plan.id,
          actionKey,
          terms,
          maxGasUsd: plan.maxGasUsd,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // A prior ambiguous/pending action owns the plan until it is resolved. A
    // new schedule tick recovers that action and conservatively skips its own
    // installment rather than creating overlapping economic intent.
    const blocking = getBlockingExecution(plan.id);
    const activeTerms = blocking?.terms ?? terms;
    const activeMaxGasUsd = blocking?.maxGasUsd ?? plan.maxGasUsd;
    const activeActionKey = blocking?.actionKey ?? actionKey;
    const walletAddress = this.mode.walletAddress;
    return runManagedExecution({
      apiKey: this.apiKey,
      planId: plan.id,
      actionKey: activeActionKey,
      terms: activeTerms,
      maxGasUsd: activeMaxGasUsd,
      walletAddress,
      getQuote: () => qualifiedQuote({
        apiKey: this.apiKey,
        terms: activeTerms,
        maxGasUsd: activeMaxGasUsd,
        walletAddress,
      }),
    });
  }

  getHistory(limit = 100): ExecutionIntent[] {
    return listExecutionJournal(limit);
  }

  async reconcileHistory(): Promise<ExecutionIntent[]> {
    return reconcileExecutionJournal(this.apiKey);
  }

  private printResult(plan: DCAPlan, result: ExecutionIntent, requestedActionKey: string): void {
    if (result.actionKey !== requestedActionKey) {
      console.warn(`  Recovered prior action ${result.actionKey}; skipped this schedule slot.`);
    }
    if (result.phase === "preview") {
      console.log(
        `  Preview: ${result.terms.amount} USDC → min ${result.quotedToAmountMin ?? "?"} ${result.terms.toToken}`,
      );
    } else if (result.phase === "completed") {
      console.log(
        `  Completed: ${result.actualFromAmount ?? result.terms.amount} USDC → ${result.actualToAmount ?? "?"} ${result.terms.toToken}`,
      );
    } else if (result.phase === "submitted") {
      console.log(`  Submitted: swap ${result.swapId ?? "unknown"}; awaiting terminal status.`);
    } else if (result.phase === "outcome_unknown") {
      console.warn(`  OUTCOME UNKNOWN: ${result.error ?? "reconcile before another action"}`);
    } else if (result.phase === "failed") {
      console.log(`  Failed safely: ${result.error ?? "unknown failure"}`);
    } else {
      console.log(`  ${plan.name}: ${result.phase}`);
    }
  }
}
