import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { DCAPlan } from "./dca.js";

export interface DCAConfig {
  apiKey: string;
  plans: DCAPlan[];
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".suwappu-dca", "config.json");

export function loadConfig(configPath?: string): DCAConfig {
  const apiKey = process.env.SUWAPPU_API_KEY;
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;

  let fileConfig: { apiKey?: string; plans?: DCAPlan[] } = { plans: [] };

  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf-8");
    fileConfig = JSON.parse(raw);
  }

  const resolvedKey = apiKey ?? fileConfig.apiKey;

  if (!resolvedKey) {
    throw new Error(
      "Missing API key. Set SUWAPPU_API_KEY env var or add apiKey to config."
    );
  }

  const plans = (fileConfig.plans ?? []).map((p, i) => ({
    ...p,
    id: p.id ?? `plan-${i}`,
    enabled: p.enabled !== false,
  }));

  return { apiKey: resolvedKey, plans };
}
