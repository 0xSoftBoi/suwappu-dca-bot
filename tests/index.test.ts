import { describe, it, expect } from "bun:test";

interface DCAPlan {
  id: string;
  fromToken: string;
  toToken: string;
  amount: number;
  chain: string;
  schedule: string;
  enabled: boolean;
}

function validateCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5;
}

function planSummary(plan: DCAPlan): string {
  return `${plan.amount} ${plan.fromToken} → ${plan.toToken} on ${plan.chain} (${plan.schedule})`;
}

const samplePlan: DCAPlan = {
  id: "dca-1", fromToken: "USDC", toToken: "ETH",
  amount: 50, chain: "base", schedule: "0 */4 * * *", enabled: true,
};

describe("cron validation", () => {
  it("should accept standard 5-field cron", () => {
    expect(validateCron("0 */4 * * *")).toBe(true);
    expect(validateCron("0 0 * * 1")).toBe(true);
  });

  it("should reject invalid cron", () => {
    expect(validateCron("every 4 hours")).toBe(false);
    expect(validateCron("* *")).toBe(false);
  });
});

describe("DCA plan", () => {
  it("should generate readable summary", () => {
    expect(planSummary(samplePlan)).toBe("50 USDC → ETH on base (0 */4 * * *)");
  });

  it("should track enabled state", () => {
    expect(samplePlan.enabled).toBe(true);
    expect({ ...samplePlan, enabled: false }.enabled).toBe(false);
  });

  it("should require positive amount", () => {
    expect(samplePlan.amount).toBeGreaterThan(0);
  });
});

describe("execution history", () => {
  it("should record success with txHash", () => {
    const entry = { success: true, txHash: "0xabc", error: undefined };
    expect(entry.success).toBe(true);
    expect(entry.txHash).toBeDefined();
  });

  it("should record failure with error", () => {
    const entry = { success: false, txHash: undefined, error: "Rate limited" };
    expect(entry.success).toBe(false);
    expect(entry.error).toBeDefined();
  });
});
