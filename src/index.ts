#!/usr/bin/env bun
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import {
  DEFAULT_MAX_DCA_USDC,
  loadConfig,
  validatePlan,
  type DCAPlan,
} from "./config.js";
import { DCAEngine, manualActionKey } from "./dca.js";
import {
  acquireExecutionLock,
  listExecutionJournal,
  reconcileExecutionJournal,
  resolveExecutionMode,
  type ExecutionIntent,
} from "./execution.js";
import { operationTimeoutMs } from "./suwappu.js";

const program = new Command();

function requireApiKey(): string {
  const apiKey = process.env.SUWAPPU_API_KEY;
  if (!apiKey || apiKey !== apiKey.trim()) {
    throw new Error(
      "SUWAPPU_API_KEY must be a non-empty value without surrounding whitespace. Register an agent at https://api.suwappu.bot/v1/agent/register",
    );
  }
  return apiKey;
}

function cliExecutionMode(execute: boolean) {
  return resolveExecutionMode({
    execute,
    allowManagedExecution: process.env.SUWAPPU_ALLOW_MANAGED_EXECUTION,
    walletAddress: process.env.SUWAPPU_WALLET_ADDRESS,
  });
}

function phaseLabel(intent: ExecutionIntent): string {
  switch (intent.phase) {
    case "completed": return chalk.green("COMPLETED");
    case "preview": return chalk.cyan("PREVIEW");
    case "submitted": return chalk.yellow("SUBMITTED");
    case "outcome_unknown": return chalk.bgRed.white("OUTCOME UNKNOWN");
    case "failed": return chalk.red("FAILED");
    default: return chalk.yellow(intent.phase.toUpperCase());
  }
}

function printIntent(intent: ExecutionIntent): void {
  console.log(
    `  ${intent.createdAt}  ${phaseLabel(intent)}  ${intent.terms.amount} USDC → ${intent.terms.toToken} (${intent.terms.chain})`,
  );
  console.log(`    Plan/action: ${intent.planId} / ${intent.actionKey}`);
  if (intent.quoteId) console.log(`    Quote: ${intent.quoteId}`);
  if (intent.quotedToAmountMin) {
    console.log(`    Quoted minimum: ${intent.quotedToAmountMin} ${intent.terms.toToken}`);
  }
  if (intent.estimatedGasUsd !== undefined) {
    console.log(`    Estimated gas: $${intent.estimatedGasUsd} / max $${intent.maxGasUsd}`);
  }
  if (intent.swapId) console.log(`    Swap: ${intent.swapId} (${intent.swapStatus ?? "status pending"})`);
  if (intent.txHash) console.log(`    TX: ${intent.txHash}`);
  if (intent.actualToAmount) {
    console.log(`    Final: ${intent.actualFromAmount ?? "?"} USDC → ${intent.actualToAmount} ${intent.terms.toToken}`);
  }
  if (intent.error) console.log(`    Note: ${intent.error}`);
}

program
  .name("suwappu-dca")
  .description("Outcome-safe fixed-USDC DCA scheduler using Suwappu")
  .version("2.0.0");

program
  .command("start")
  .description("Start configured DCA schedules (preview-only unless --execute is explicitly enabled)")
  .option("-c, --config <path>", "Config file path")
  .option("--execute", "Enable managed-wallet swap submission", false)
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const apiKey = requireApiKey();
    operationTimeoutMs();
    const mode = cliExecutionMode(Boolean(opts.execute));
    const engine = new DCAEngine(apiKey, mode);
    for (const plan of config.plans) engine.addPlan(plan);
    const releaseLock = acquireExecutionLock();

    try {
      console.log(chalk.bold("Suwappu DCA Scheduler"));
      console.log(chalk.dim("─".repeat(50)));
      console.log(
        mode.kind === "managed"
          ? chalk.yellow("  Mode: MANAGED (durable intent → simulate → idempotent submit → reconcile)")
          : chalk.green("  Mode: PREVIEW (quote + cost guard only; no submission)"),
      );
      console.log(`  Per-action ceiling: ${process.env.SUWAPPU_MAX_DCA_USDC ?? DEFAULT_MAX_DCA_USDC} USDC`);
      for (const plan of config.plans) {
        console.log(
          `  ${chalk.cyan(plan.name)}: ${plan.amount} USDC → ${plan.toToken} on ${plan.chain}`,
        );
        console.log(
          `    ${plan.schedule} ${plan.timezone} | max gas $${plan.maxGasUsd} | ${plan.enabled ? "enabled" : "disabled"}`,
        );
      }
      console.log(chalk.dim("\nPress Ctrl+C to stop.\n"));

      engine.start();
      const shutdown = () => {
        engine.stop();
        releaseLock();
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      await new Promise(() => {});
    } catch (error) {
      engine.stop();
      releaseLock();
      throw error;
    }
  });

program
  .command("status")
  .description("Validate and show configured DCA plans")
  .option("-c, --config <path>", "Config file path")
  .action((opts) => {
    const config = loadConfig(opts.config);
    console.log(chalk.bold("DCA Plans"));
    console.log(chalk.dim("─".repeat(60)));
    for (const plan of config.plans) {
      console.log(`  ${chalk.cyan(plan.name)} (${plan.id})`);
      console.log(`    ${plan.amount} USDC → ${plan.toToken} on ${plan.chain}`);
      console.log(`    Schedule: ${plan.schedule} | timezone: ${plan.timezone}`);
      console.log(`    Max gas: $${plan.maxGasUsd}`);
      console.log(`    Enabled: ${plan.enabled ? chalk.green("yes") : chalk.red("no")}`);
      console.log();
    }
  });

program
  .command("history")
  .description("Show the durable DCA action journal")
  .option("-n, --limit <count>", "Number of entries", "20")
  .option("--reconcile", "Poll known swap IDs before printing; never submit", false)
  .action(async (opts) => {
    const limit = Number.parseInt(opts.limit, 10);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
    let history: ExecutionIntent[];
    if (opts.reconcile) {
      const apiKey = requireApiKey();
      operationTimeoutMs();
      const releaseLock = acquireExecutionLock();
      try {
        history = (await reconcileExecutionJournal(apiKey)).slice(0, limit);
      } finally {
        releaseLock();
      }
    } else {
      history = listExecutionJournal(limit);
    }
    if (history.length === 0) {
      console.log(chalk.dim("No DCA actions recorded."));
      return;
    }
    console.log(chalk.bold("DCA Action Journal"));
    console.log(chalk.dim("─".repeat(70)));
    for (const intent of history) printIntent(intent);
  });

program
  .command("run-once")
  .description("Preview one fixed-USDC DCA action; pass --execute for managed submission")
  .option("--from <token>", "Source token; this reference accepts USDC only", "USDC")
  .requiredOption("--to <token>", "Target token")
  .requiredOption("--amount <amount>", "USDC amount")
  .requiredOption("--chain <chain>", "Chain to quote/execute on")
  .requiredOption("--max-gas-usd <usd>", "Maximum estimated gas for this action")
  .option("--execute", "Enable managed-wallet swap submission", false)
  .action(async (opts) => {
    const amount = Number(opts.amount);
    const maxGasUsd = Number(opts.maxGasUsd);
    const plan = validatePlan({
      id: "manual",
      name: "Manual DCA Action",
      fromToken: opts.from,
      toToken: opts.to,
      amount,
      chain: opts.chain,
      schedule: "0 * * * *",
      timezone: "UTC",
      maxGasUsd,
      enabled: true,
    }, "manual action");
    const mode = cliExecutionMode(Boolean(opts.execute));
    const apiKey = requireApiKey();
    operationTimeoutMs();
    const engine = new DCAEngine(apiKey, mode);
    const spinner = ora(
      mode.kind === "managed"
        ? `Running durable managed action for ${plan.amount} USDC → ${plan.toToken}...`
        : `Previewing ${plan.amount} USDC → ${plan.toToken}...`,
    ).start();
    const releaseLock = acquireExecutionLock();
    let result: ExecutionIntent;
    try {
      result = await engine.executeBuy(plan, manualActionKey());
    } finally {
      releaseLock();
    }

    if (result.phase === "preview") {
      spinner.succeed(
        chalk.green(
          `Preview: ${plan.amount} USDC → min ${result.quotedToAmountMin ?? "?"} ${plan.toToken} (no submission)`,
        ),
      );
    } else if (result.phase === "completed") {
      spinner.succeed(
        chalk.green(
          `Completed swap ${result.swapId ?? "unknown"}: ${result.actualToAmount ?? "?"} ${result.terms.toToken}`,
        ),
      );
    } else if (result.phase === "submitted") {
      spinner.succeed(chalk.yellow(`Submitted swap ${result.swapId ?? "unknown"}; reconcile to terminal status.`));
    } else if (result.phase === "outcome_unknown") {
      spinner.fail(chalk.red(`Outcome unknown: ${result.error ?? "do not create a fresh economic action"}`));
      process.exitCode = 2;
    } else {
      spinner.fail(chalk.red(`Failed safely: ${result.error ?? result.phase}`));
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
