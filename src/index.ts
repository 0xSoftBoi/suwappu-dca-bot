#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "./config.js";
import { DCAEngine } from "./dca.js";

const program = new Command();

program
  .name("suwappu-dca")
  .description("Automated DCA bot using Suwappu cross-chain DEX")
  .version("1.0.0");

program
  .command("start")
  .description("Start DCA schedule")
  .option("-c, --config <path>", "Config file path")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const engine = new DCAEngine(config.apiKey);

    for (const plan of config.plans) {
      engine.addPlan(plan);
    }

    console.log(chalk.bold("DCA Bot Started"));
    console.log(chalk.dim("─".repeat(40)));
    for (const plan of config.plans) {
      console.log(
        `  ${chalk.cyan(plan.name)}: $${plan.amount} ${plan.fromToken} → ${plan.toToken} on ${plan.chain}`
      );
      console.log(`    Schedule: ${plan.schedule}`);
    }
    console.log(chalk.dim("\nPress Ctrl+C to stop.\n"));

    engine.start();

    // Keep alive
    await new Promise(() => {});
  });

program
  .command("status")
  .description("Show active DCA plans")
  .option("-c, --config <path>", "Config file path")
  .action((opts) => {
    const config = loadConfig(opts.config);

    console.log(chalk.bold("DCA Plans"));
    console.log(chalk.dim("─".repeat(50)));

    for (const plan of config.plans) {
      console.log(`  ${chalk.cyan(plan.name)}`);
      console.log(`    ${plan.fromToken} → ${plan.toToken}: $${plan.amount}`);
      console.log(`    Chain: ${plan.chain}`);
      console.log(`    Schedule: ${plan.schedule}`);
      console.log(`    Enabled: ${plan.enabled !== false ? chalk.green("yes") : chalk.red("no")}`);
      console.log();
    }
  });

program
  .command("history")
  .description("Show DCA execution history")
  .option("-c, --config <path>", "Config file path")
  .option("-n, --limit <count>", "Number of entries", "20")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const engine = new DCAEngine(config.apiKey);
    const history = engine.getHistory();

    if (history.length === 0) {
      console.log(chalk.dim("No execution history yet."));
      return;
    }

    const limit = parseInt(opts.limit, 10);
    console.log(chalk.bold("Execution History"));
    console.log(chalk.dim("─".repeat(60)));

    for (const entry of history.slice(-limit)) {
      const status = entry.success ? chalk.green("OK") : chalk.red("FAIL");
      console.log(
        `  ${entry.timestamp}  ${status}  $${entry.amount} ${entry.fromToken} → ${entry.toToken} (${entry.chain})`
      );
      if (entry.txHash) {
        console.log(`    TX: ${entry.txHash}`);
      }
      if (entry.error) {
        console.log(`    Error: ${entry.error}`);
      }
    }
  });

program
  .command("run-once")
  .description("Execute a single DCA buy immediately")
  .requiredOption("--from <token>", "Source token")
  .requiredOption("--to <token>", "Target token")
  .requiredOption("--amount <usd>", "USD amount")
  .requiredOption("--chain <chain>", "Chain to execute on")
  .action(async (opts) => {
    const config = loadConfig();
    const engine = new DCAEngine(config.apiKey);
    const spinner = ora(`Buying $${opts.amount} of ${opts.to}...`).start();

    const result = await engine.executeBuy({
      id: "manual",
      name: "Manual Buy",
      fromToken: opts.from,
      toToken: opts.to,
      amount: parseFloat(opts.amount),
      chain: opts.chain,
      schedule: "",
    });

    if (result.success) {
      spinner.succeed(
        chalk.green(`Bought ${opts.to} for $${opts.amount} — TX: ${result.txHash}`)
      );
    } else {
      spinner.fail(chalk.red(`Failed: ${result.error}`));
    }
  });

program.parse();
