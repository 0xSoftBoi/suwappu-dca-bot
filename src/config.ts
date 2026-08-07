import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import cron from "node-cron";

export const DEFAULT_MAX_DCA_USDC = "1000";

export interface DCAPlan {
  id: string;
  name: string;
  fromToken: "USDC";
  toToken: string;
  amount: number;
  chain: string;
  schedule: string;
  timezone: string;
  maxGasUsd: number;
  enabled: boolean;
}

export interface DCAConfig {
  apiKey: string;
  plans: DCAPlan[];
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".suwappu-dca", "config.json");
const PLAN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Config validation failed: ${field} must be a non-empty string.`);
  }
  return value.trim();
}

export function requireUsdcAmount(amount: number, capText: string): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("DCA amount must be a positive USDC amount");
  }
  const cap = Number(capText);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error("SUWAPPU_MAX_DCA_USDC must be a positive number");
  }
  if (amount > cap) {
    throw new Error(`DCA amount ${amount} USDC exceeds SUWAPPU_MAX_DCA_USDC=${cap}`);
  }
  return amount;
}

/**
 * This reference intentionally permits at most one trigger per hour. Requiring
 * one literal minute value avoids cron aliases such as an every-minute step or 0-59 that are just
 * disguised every-minute schedules.
 */
export function validateDcaSchedule(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 || !cron.validate(schedule)) return false;
  return /^(?:[0-9]|[1-5][0-9])$/.test(fields[0] ?? "");
}

export function validateTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function validatePlan(
  input: unknown,
  indexLabel: string,
  capText = process.env.SUWAPPU_MAX_DCA_USDC ?? DEFAULT_MAX_DCA_USDC,
): DCAPlan {
  if (!isRecord(input)) {
    throw new Error(`Config validation failed: ${indexLabel} must be an object.`);
  }

  const id = requiredString(input.id, `${indexLabel}.id`);
  if (!PLAN_ID_PATTERN.test(id)) {
    throw new Error(
      `Config validation failed: ${indexLabel}.id must be 1-40 characters using A-Z, a-z, 0-9, _, ., :, or -.`,
    );
  }
  const name = requiredString(input.name, `${indexLabel}.name`);
  const fromToken = requiredString(input.fromToken, `${indexLabel}.fromToken`).toUpperCase();
  if (fromToken !== "USDC") {
    throw new Error(
      `Config validation failed: ${indexLabel}.fromToken must be USDC so this DCA reference has fixed-dollar accounting.`,
    );
  }
  const toToken = requiredString(input.toToken, `${indexLabel}.toToken`).toUpperCase();
  if (toToken === "USDC") {
    throw new Error(`Config validation failed: ${indexLabel}.toToken must be a non-USDC token.`);
  }
  if (typeof input.amount !== "number") {
    throw new Error(`Config validation failed: ${indexLabel}.amount must be a number.`);
  }
  const amount = requireUsdcAmount(input.amount, capText);
  const chain = requiredString(input.chain, `${indexLabel}.chain`).toLowerCase();
  const schedule = requiredString(input.schedule, `${indexLabel}.schedule`);
  if (!validateDcaSchedule(schedule)) {
    throw new Error(
      `Config validation failed: ${indexLabel}.schedule must be a valid 5-field cron with one fixed minute (minimum cadence: hourly).`,
    );
  }
  const timezone = input.timezone === undefined
    ? "UTC"
    : requiredString(input.timezone, `${indexLabel}.timezone`);
  if (!validateTimezone(timezone)) {
    throw new Error(`Config validation failed: ${indexLabel}.timezone must be a valid IANA timezone.`);
  }
  if (typeof input.maxGasUsd !== "number" || !Number.isFinite(input.maxGasUsd) || input.maxGasUsd <= 0) {
    throw new Error(`Config validation failed: ${indexLabel}.maxGasUsd must be a positive number.`);
  }
  if (input.maxGasUsd > amount) {
    throw new Error(`Config validation failed: ${indexLabel}.maxGasUsd cannot exceed the DCA amount.`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new Error(`Config validation failed: ${indexLabel}.enabled must be a boolean.`);
  }

  return {
    id,
    name,
    fromToken: "USDC",
    toToken,
    amount,
    chain,
    schedule,
    timezone,
    maxGasUsd: input.maxGasUsd,
    enabled: input.enabled !== false,
  };
}

export function loadConfig(configPath?: string): DCAConfig {
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Config file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.plans)) {
    throw new Error("Config validation failed: 'plans' must be an array.");
  }

  const apiKey = process.env.SUWAPPU_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing API key. Set SUWAPPU_API_KEY; this reference does not load credentials from the plan file.",
    );
  }

  const capText = process.env.SUWAPPU_MAX_DCA_USDC ?? DEFAULT_MAX_DCA_USDC;
  const plans = parsed.plans.map((plan, index) => validatePlan(plan, `plan[${index}]`, capText));
  const ids = new Set<string>();
  for (const plan of plans) {
    if (ids.has(plan.id)) throw new Error(`Config validation failed: duplicate plan id '${plan.id}'.`);
    ids.add(plan.id);
  }
  return { apiKey, plans };
}
