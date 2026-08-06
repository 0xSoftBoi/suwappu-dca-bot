#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "./config.js";
import { DCAEngine } from "./dca.js";
import { resolveExecutionMode } from "./execution.js";

const program = new Command();

function cliExecutionMode(execute: boolean) {
  return resolveExecutionMode({
    execute,
    allowManagedExecution: process.env.SUWAPPU_ALLOW_MANAGED_EXECUTION,
    walletAddress: process.env.SUWAPPU_WALLET_ADDRESS,
  });
}

program
  .name("suwappu-dca")
  .description("Preview-first DCA scheduler using Suwappu")
  .version("1.0.0");

program
  .command("start")
  .description("Start the DCA scheduler (preview-only unless --execute is explicitly enabled)")
  .option("-c, --config <path>", "Config file path")
  .option("--execute", "Enable managed-wallet swap submission", false)
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const mode = cliExecutionMode(Boolean(opts.execute));
    const engine = new DCAEngine(config.apiKey, mode);

    for (const plan of config.plans) engine.addPlan(plan);

    console.log(chalk.bold("DCA Bot Started"));
    console.log(chalk.dim("─".repeat(40)));
    console.log(
      mode.kind === "managed"
        ? chalk.yellow("  Mode: MANAGED EXECUTION (each quote is simulated first)")
        : chalk.green("  Mode: PREVIEW (quotes only; no transactions submitted)"),
    );

    for (const plan of config.plans) {
      console.log(
        `  ${chalk.cyan(plan.name)}: ${plan.amount} ${plan.fromToken} → ${plan.toToken} on ${plan.chain}`,
      );
      console.log(`    Schedule: ${plan.schedule}`);
      console.log(`    Timezone: ${plan.timezone ?? "host default"}`);
    }
    console.log(chalk.dim("\nPress Ctrl+C to stop.\n"));

    engine.start();
    await new Promise(() => {});
  });

program
  .command("status")
  .description("Show configured DCA plans")
  .option("-c, --config <path>", "Config file path")
  .action((opts) => {
    const config = loadConfig(opts.config);

    console.log(chalk.bold("DCA Plans"));
    console.log(chalk.dim("─".repeat(50)));

    for (const plan of config.plans) {
      console.log(`  ${chalk.cyan(plan.name)}`);
      console.log(`    ${plan.fromToken} → ${plan.toToken}: ${plan.amount} ${plan.fromToken}`);
      console.log(`    Chain: ${plan.chain}`);
      console.log(`    Schedule: ${plan.schedule}`);
      console.log(`    Timezone: ${plan.timezone ?? "host default"}`);
      console.log(
        `    Enabled: ${plan.enabled !== false ? chalk.green("yes") : chalk.red("no")}`,
      );
      console.log();
    }
  });

program
  .command("history")
  .description("Show DCA preview/submission history")
  .option("-c, --config <path>", "Config file path")
  .option("-n, --limit <count>", "Number of entries", "20")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const engine = new DCAEngine(config.apiKey);
    const history = engine.getHistory();

    if (history.length === 0) {
      console.log(chalk.dim("No DCA history yet."));
      return;
    }

    const limit = Number.parseInt(opts.limit, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("--limit must be a positive integer");
    }

    console.log(chalk.bold("DCA History"));
    console.log(chalk.dim("─".repeat(60)));

    for (const entry of history.slice(-limit)) {
      const status =
        entry.outcome === "submitted"
          ? chalk.green("SUBMITTED")
          : entry.outcome === "preview"
            ? chalk.cyan("PREVIEW")
            : chalk.red("FAILED");
      console.log(
        `  ${entry.timestamp}  ${status}  ${entry.amount} ${entry.fromToken} → ${entry.toToken} (${entry.chain})`,
      );
      if (entry.quoteId) console.log(`    Quote: ${entry.quoteId}`);
      if (entry.toAmount) console.log(`    Quoted output: ${entry.toAmount} ${entry.toToken}`);
      if (entry.swapId) console.log(`    Swap: ${entry.swapId}`);
      if (entry.txHash) console.log(`    TX: ${entry.txHash}`);
      if (entry.error) console.log(`    Error: ${entry.error}`);
    }
  });

program
  .command("run-once")
  .description("Preview one DCA buy; pass --execute for managed submission")
  .option("-c, --config <path>", "Config file path")
  .requiredOption("--from <token>", "Source token")
  .requiredOption("--to <token>", "Target token")
  .requiredOption("--amount <amount>", "Source-token amount")
  .requiredOption("--chain <chain>", "Chain to execute on")
  .option("--execute", "Enable managed-wallet swap submission", false)
  .action(async (opts) => {
    const amount = Number.parseFloat(opts.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("--amount must be a positive source-token amount");
    }

    const config = loadConfig(opts.config);
    const mode = cliExecutionMode(Boolean(opts.execute));
    const engine = new DCAEngine(config.apiKey, mode);
    const spinner = ora(
      mode.kind === "managed"
        ? `Simulating then submitting ${amount} ${opts.from} → ${opts.to}...`
        : `Previewing ${amount} ${opts.from} → ${opts.to}...`,
    ).start();

    const result = await engine.executeBuy({
      id: "manual",
      name: "Manual Buy",
      fromToken: opts.from,
      toToken: opts.to,
      amount,
      chain: opts.chain,
      schedule: "",
    });

    if (result.outcome === "preview") {
      spinner.succeed(
        chalk.green(
          `Preview: ${amount} ${opts.from} → ${result.toAmount ?? "?"} ${opts.to} (no transaction submitted)`,
        ),
      );
    } else if (result.outcome === "submitted") {
      spinner.succeed(
        chalk.green(
          `Submitted swap ${result.swapId ?? "unknown"} — TX: ${result.txHash ?? "pending"}`,
        ),
      );
    } else {
      spinner.fail(chalk.red(`Failed: ${result.error}`));
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
