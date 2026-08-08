import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireExecutionLock,
  getBlockingExecution,
  listExecutionJournal,
  reconcileExecutionJournal,
  recordPreview,
  resolveExecutionMode,
  runManagedExecution,
  type EconomicTerms,
} from "../src/execution.js";
import { DCAEngine } from "../src/dca.js";
import type { DCAPlan } from "../src/config.js";

const originalFetch = globalThis.fetch;
const originalStateDir = process.env.SUWAPPU_DCA_STATE_DIR;
const originalApiUrl = process.env.SUWAPPU_API_URL;
const originalJournalLimit = process.env.SUWAPPU_DCA_JOURNAL_LIMIT;
const terms: EconomicTerms = {
  fromToken: "USDC",
  toToken: "ETH",
  amount: "50",
  chain: "base",
};
let stateDir = "";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quote(id = "q1") {
  return {
    id,
    toAmount: "0.026",
    toAmountMin: "0.025",
    estimatedGasUsd: 1,
    reportedRouteFeeUsd: 0.2,
    expiresAtMs: Date.now() + 60_000,
  };
}

function simulationResponse(init?: RequestInit, wouldExecute = true, warnings: string[] = []): Response {
  const body = JSON.parse(String(init?.body)) as { quote_id?: unknown };
  return jsonResponse({
    success: true,
    quote_id: body.quote_id,
    would_execute: wouldExecute,
    warnings,
  });
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "suwappu-dca-test-"));
  process.env.SUWAPPU_DCA_STATE_DIR = stateDir;
  process.env.SUWAPPU_API_URL = "https://example.test";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStateDir === undefined) delete process.env.SUWAPPU_DCA_STATE_DIR;
  else process.env.SUWAPPU_DCA_STATE_DIR = originalStateDir;
  if (originalApiUrl === undefined) delete process.env.SUWAPPU_API_URL;
  else process.env.SUWAPPU_API_URL = originalApiUrl;
  if (originalJournalLimit === undefined) delete process.env.SUWAPPU_DCA_JOURNAL_LIMIT;
  else process.env.SUWAPPU_DCA_JOURNAL_LIMIT = originalJournalLimit;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("DCA execution gate", () => {
  it("defaults to preview and requires both independent live gates", () => {
    expect(resolveExecutionMode({
      execute: false,
      allowManagedExecution: "1",
      walletAddress: "0xabc",
    })).toEqual({ kind: "preview" });
    expect(() => resolveExecutionMode({ execute: true, walletAddress: "0xabc" }))
      .toThrow("SUWAPPU_ALLOW_MANAGED_EXECUTION=1");
    expect(() => resolveExecutionMode({ execute: true, allowManagedExecution: "1" }))
      .toThrow("SUWAPPU_WALLET_ADDRESS");
  });
});

describe("durable recurring execution", () => {
  it("fails closed before quoting if the durable journal is unreadable", async () => {
    writeFileSync(join(stateDir, "execution-journal.json"), "not-json");
    let quoteCalls = 0;
    await expect(runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => {
        quoteCalls += 1;
        return quote();
      },
    })).rejects.toThrow("Execution journal is unreadable");
    expect(quoteCalls).toBe(0);
  });

  it("does not execute when simulation says would_execute=false", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return simulationResponse(init, false, ["policy denied"]);
    }) as unknown as typeof fetch;

    const intent = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => quote(),
    });
    expect(intent.phase).toBe("failed");
    expect(paths).toEqual(["/v1/agent/swap/simulate"]);
  });

  it("re-checks quote TTL after simulation before submission", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/swap/simulate")) return simulationResponse(init);
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const intent = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => ({ ...quote(), expiresAtMs: Date.now() + 1_000 }),
    });
    expect(intent.phase).toBe("failed");
    expect(intent.error).toContain("after simulation");
    expect(paths).toEqual(["/v1/agent/swap/simulate"]);
  });

  it("treats HTTP 408 after managed submission begins as outcome-unknown without echoing the body", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) return simulationResponse(init);
      if (path.endsWith("/swap/execute")) {
        return jsonResponse({ error: "upstream-secret-detail" }, 408);
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const intent = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => quote(),
    });
    expect(intent.phase).toBe("outcome_unknown");
    expect(intent.error).toContain("408");
    expect(intent.error).not.toContain("upstream-secret-detail");
  });

  it("treats a malformed successful execute response as outcome-unknown", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) return simulationResponse(init);
      if (path.endsWith("/swap/execute")) {
        return jsonResponse({ swap_id: "swap-without-success", status: "pending" });
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const intent = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => quote(),
    });
    expect(intent.phase).toBe("outcome_unknown");
    expect(intent.error).toBe("Malformed managed swap response");
  });

  it("retries an ambiguous submit using the exact same idempotency key", async () => {
    const keys: string[] = [];
    let executeCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) {
        return simulationResponse(init);
      }
      if (path.endsWith("/swap/execute")) {
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        executeCalls += 1;
        if (executeCalls === 1) throw new TypeError("connection reset after write");
        return jsonResponse({ success: true, swap_id: "swap-1", status: "pending" });
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const first = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => quote("q1"),
    });
    expect(first.phase).toBe("outcome_unknown");
    expect(getBlockingExecution("daily-eth")?.id).toBe(first.id);

    const second = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => quote("q2"),
    });
    expect(second.phase).toBe("submitted");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(first.id);
  });

  it("lets an unresolved prior slot own the plan instead of creating a new installment", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) return simulationResponse(init);
      if (path.endsWith("/swap/execute")) throw new TypeError("connection reset after write");
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const first = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => quote("q-first"),
    });
    expect(first.phase).toBe("outcome_unknown");

    let executeKey = "";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/quote")) {
        return jsonResponse({
          success: true,
          quote_id: "q-recovery",
          amount_in: "50",
          amount_out: "0.026",
          amount_out_min: "0.025",
          estimated_gas_usd: "1",
          bridge_fee_usd: "0.2",
          expires_in_seconds: 60,
          from_token: "USDC",
          to_token: "ETH",
        });
      }
      if (path.endsWith("/swap/simulate")) return simulationResponse(init);
      if (path.endsWith("/swap/execute")) {
        executeKey = new Headers(init?.headers).get("Idempotency-Key") ?? "";
        return jsonResponse({ success: true, swap_id: "swap-recovered", status: "pending" });
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const plan: DCAPlan = {
      id: "daily-eth",
      name: "Daily ETH",
      fromToken: "USDC",
      toToken: "ETH",
      amount: 50,
      chain: "base",
      schedule: "0 * * * *",
      timezone: "UTC",
      maxGasUsd: 2,
      enabled: true,
    };
    const engine = new DCAEngine("key", { kind: "managed", walletAddress: "0xabc" });
    const recovered = await engine.executeBuy(plan, "schedule.20260807T1000");

    expect(recovered.id).toBe(first.id);
    expect(recovered.actionKey).toBe("schedule.20260807T0900");
    expect(executeKey).toBe(first.id);
  });

  it("polls a known pending swap instead of submitting it again", async () => {
    let executeCalls = 0;
    let statusCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) return simulationResponse(init);
      if (path.endsWith("/swap/execute")) {
        executeCalls += 1;
        return jsonResponse({ success: true, swap_id: "swap-pending", status: "pending" });
      }
      if (path.endsWith("/swap/status/swap-pending")) {
        statusCalls += 1;
        return jsonResponse({ success: true, swap_id: "swap-pending", status: "pending" });
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => quote(),
    });
    const second = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => {
        throw new Error("known swaps must not request a new quote");
      },
    });
    expect(second.phase).toBe("submitted");
    expect(executeCalls).toBe(1);
    expect(statusCalls).toBe(1);
  });

  it("records reconciled final amounts separately from quoted amounts", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) return simulationResponse(init);
      if (path.endsWith("/swap/execute")) {
        return jsonResponse({ success: true, swap_id: "swap-done", status: "completed", tx_hash: "0xabc" });
      }
      if (path.endsWith("/swap/status/swap-done")) {
        return jsonResponse({
          success: true,
          swap_id: "swap-done",
          status: "completed",
          from_amount: "49.9",
          to_amount: "0.0247",
        });
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const intent = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => quote(),
    });
    expect(intent.phase).toBe("completed");
    expect(intent.quotedToAmount).toBe("0.026");
    expect(intent.actualFromAmount).toBe("49.9");
    expect(intent.actualToAmount).toBe("0.0247");
  });

  it("keeps reconciling terminal swaps when final amounts were temporarily unavailable", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) return simulationResponse(init);
      if (path.endsWith("/swap/execute")) {
        return jsonResponse({ success: true, swap_id: "swap-late-final", status: "completed" });
      }
      if (path.endsWith("/swap/status/swap-late-final")) {
        return jsonResponse({ error: "indexer unavailable" }, 503);
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    const first = await runManagedExecution({
      apiKey: "key",
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      walletAddress: "0xabc",
      getQuote: async () => quote(),
    });
    expect(first.phase).toBe("completed");
    expect(first.actualToAmount).toBeUndefined();

    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/status/swap-late-final")) {
        return jsonResponse({ success: true, swap_id: "swap-late-final", status: "pending" });
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;
    const stale = await reconcileExecutionJournal("key");
    expect(stale[0].phase).toBe("completed");

    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/status/swap-late-final")) {
        return jsonResponse({
          success: true,
          swap_id: "swap-late-final",
          status: "completed",
          from_amount: "49.8",
          to_amount: "0.0245",
        });
      }
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;
    const journal = await reconcileExecutionJournal("key");
    expect(journal[0].actualFromAmount).toBe("49.8");
    expect(journal[0].actualToAmount).toBe("0.0245");
  });

  it("enforces one local journal writer and releases only its own lock", () => {
    const release = acquireExecutionLock();
    expect(() => acquireExecutionLock()).toThrow("another journal writer may be active");
    expect(statSync(join(stateDir, "execution.lock")).mode & 0o777).toBe(0o600);
    release();

    const releaseAgain = acquireExecutionLock();
    releaseAgain();
  });

  it("rejects invalid retention config before creating a lock", () => {
    process.env.SUWAPPU_DCA_JOURNAL_LIMIT = "0";
    expect(() => acquireExecutionLock()).toThrow("between 1 and 100000");
    expect(existsSync(join(stateDir, "execution.lock"))).toBe(false);
  });

  it("persists state with owner-only permissions", () => {
    recordPreview({
      planId: "daily-eth",
      actionKey: "schedule.20260807T0900",
      terms,
      maxGasUsd: 2,
      quote: quote(),
    });
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, "execution-journal.json")).mode & 0o777).toBe(0o600);
  });

  it("treats retention as a soft target and never prunes unresolved idempotency state", async () => {
    process.env.SUWAPPU_DCA_JOURNAL_LIMIT = "1";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/swap/simulate")) return simulationResponse(init);
      if (path.endsWith("/swap/execute")) throw new TypeError("connection lost after write");
      throw new Error(`unexpected path ${path}`);
    }) as unknown as typeof fetch;

    for (const [planId, actionKey] of [
      ["plan-a", "schedule.20260807T0900"],
      ["plan-b", "schedule.20260807T0900"],
    ]) {
      const intent = await runManagedExecution({
        apiKey: "key",
        planId,
        actionKey,
        terms,
        maxGasUsd: 2,
        walletAddress: "0xabc",
        getQuote: async () => quote(`${planId}-quote`),
      });
      expect(intent.phase).toBe("outcome_unknown");
    }

    expect(listExecutionJournal(10)).toHaveLength(2);
  });
});
