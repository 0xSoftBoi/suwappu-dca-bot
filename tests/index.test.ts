import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  validateDcaSchedule,
  validatePlan,
  type DCAPlan,
} from "../src/config.js";
import { qualifyDcaQuote, scheduledActionKey } from "../src/dca.js";
import {
  getQuote,
  operationTimeoutMs,
  simulateSwap,
  type QuoteResult,
} from "../src/suwappu.js";

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.SUWAPPU_API_URL;
const originalApiKey = process.env.SUWAPPU_API_KEY;
const originalOperationTimeout = process.env.SUWAPPU_OPERATION_TIMEOUT_MS;

const basePlan: DCAPlan = {
  id: "daily-eth",
  name: "Daily ETH",
  fromToken: "USDC",
  toToken: "ETH",
  amount: 50,
  chain: "base",
  schedule: "0 9 * * *",
  timezone: "America/New_York",
  maxGasUsd: 2,
  enabled: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) delete process.env.SUWAPPU_API_URL;
  else process.env.SUWAPPU_API_URL = originalApiUrl;
  if (originalApiKey === undefined) delete process.env.SUWAPPU_API_KEY;
  else process.env.SUWAPPU_API_KEY = originalApiKey;
  if (originalOperationTimeout === undefined) delete process.env.SUWAPPU_OPERATION_TIMEOUT_MS;
  else process.env.SUWAPPU_OPERATION_TIMEOUT_MS = originalOperationTimeout;
});

describe("DCA plan contract", () => {
  it("uses fixed USDC accounting, an explicit id, gas ceiling, and timezone", () => {
    expect(validatePlan(basePlan, "plan", "100")).toEqual(basePlan);
    expect(validatePlan({ ...basePlan, timezone: undefined }, "plan", "100").timezone).toBe("UTC");
  });

  it("rejects non-USDC source units and actions above the client cap", () => {
    expect(() => validatePlan({ ...basePlan, fromToken: "ETH" }, "plan", "100"))
      .toThrow("fixed-dollar accounting");
    expect(() => validatePlan({ ...basePlan, amount: 101 }, "plan", "100"))
      .toThrow("SUWAPPU_MAX_DCA_USDC");
  });

  it("requires a stable explicit plan id and a positive gas ceiling", () => {
    const { id: _id, ...withoutId } = basePlan;
    expect(() => validatePlan(withoutId, "plan", "100")).toThrow("plan.id");
    expect(() => validatePlan({ ...basePlan, maxGasUsd: 0 }, "plan", "100"))
      .toThrow("maxGasUsd");
  });

  it("allows no more than one cron trigger per hour", () => {
    expect(validateDcaSchedule("0 * * * *")).toBe(true);
    expect(validateDcaSchedule("30 9 * * 1")).toBe(true);
    expect(validateDcaSchedule("* * * * *")).toBe(false);
    expect(validateDcaSchedule("*/1 * * * *")).toBe(false);
    expect(validateDcaSchedule("0-59 * * * *")).toBe(false);
  });

  it("deduplicates a repeated DST wall-clock schedule slot", () => {
    const plan = validatePlan({ ...basePlan, schedule: "30 1 * * *" }, "plan", "100") as DCAPlan;
    // America/New_York 01:30 occurs twice when DST falls back on 2026-11-01.
    const first = scheduledActionKey(plan, new Date("2026-11-01T05:30:00Z"));
    const second = scheduledActionKey(plan, new Date("2026-11-01T06:30:00Z"));
    expect(first).toBe("schedule.20261101T0130");
    expect(second).toBe(first);
  });

  it("validates a plan file locally without requiring an API credential", () => {
    const dir = mkdtempSync(join(tmpdir(), "suwappu-dca-config-test-"));
    const path = join(dir, "config.json");
    try {
      delete process.env.SUWAPPU_API_KEY;
      writeFileSync(path, JSON.stringify({ plans: [basePlan] }));
      expect(loadConfig(path).plans[0]?.id).toBe("daily-eth");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("quote promotion", () => {
  const quote: QuoteResult = {
    id: "q1",
    fromAmount: "50",
    toAmount: "0.026",
    toAmountMin: "0.025",
    estimatedGasUsd: 1.25,
    reportedRouteFeeUsd: 0.2,
    dex: "router",
    expiresAtMs: 70_000,
  };

  it("requires gas below the plan ceiling and more than five seconds of TTL", () => {
    expect(qualifyDcaQuote(quote, 2, 0).toAmountMin).toBe("0.025");
    expect(() => qualifyDcaQuote({ ...quote, estimatedGasUsd: 2.01 }, 2, 0))
      .toThrow("exceeds plan maxGasUsd");
    expect(() => qualifyDcaQuote({ ...quote, estimatedGasUsd: null }, 2, 0))
      .toThrow("estimated_gas_usd");
    expect(() => qualifyDcaQuote({ ...quote, expiresAtMs: 5_000 }, 2, 0))
      .toThrow("5 seconds");
  });

  it("strictly parses the current quote contract", async () => {
    globalThis.fetch = (async () => jsonResponse({
      success: true,
      quote_id: "q1",
      amount_in: "50",
      amount_out: "0.026",
      amount_out_min: "0.025",
      estimated_gas_usd: "1.25",
      bridge_fee_usd: "0.20",
      expires_in_seconds: 60,
      dex: "router",
      from_token: "USDC",
      to_token: "ETH",
    })) as unknown as typeof fetch;
    const parsed = await getQuote("key", {
      from: "USDC",
      to: "ETH",
      amount: "50",
      chain: "base",
    });
    expect(parsed.fromAmount).toBe("50");
    expect(parsed.toAmountMin).toBe("0.025");
    expect(parsed.estimatedGasUsd).toBe(1.25);
  });

  it("does not confuse HTTP/top-level success with simulation permission", async () => {
    globalThis.fetch = (async () => jsonResponse({
      success: true,
      quote_id: "q1",
      would_execute: false,
      warnings: ["policy denied"],
    })) as unknown as typeof fetch;
    const simulation = await simulateSwap("key", "q1", "0xabc");
    expect(simulation.wouldExecute).toBe(false);
    expect(simulation.warnings).toEqual(["policy denied"]);
  });

  it("rejects a quote whose returned token pair does not match the request", async () => {
    globalThis.fetch = (async () => jsonResponse({
      success: true,
      quote_id: "q-wrong-pair",
      amount_in: "50",
      amount_out: "0.026",
      amount_out_min: "0.025",
      estimated_gas_usd: "1",
      expires_in_seconds: 60,
      from_token: "USDC",
      to_token: "SOL",
    })) as unknown as typeof fetch;

    await expect(getQuote("key", {
      from: "USDC",
      to: "ETH",
      amount: "50",
      chain: "base",
    })).rejects.toThrow("token pair did not match");
  });

  it("sanitizes upstream HTTP bodies and bounds operation timeouts", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "sensitive-upstream-detail" }, 403)) as unknown as typeof fetch;
    try {
      await getQuote("key", { from: "USDC", to: "ETH", amount: "50", chain: "base" });
      throw new Error("expected quote to fail");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("sensitive-upstream-detail");
    }

    process.env.SUWAPPU_OPERATION_TIMEOUT_MS = "99";
    expect(() => operationTimeoutMs()).toThrow("between 100 and 30000");
  });
});
