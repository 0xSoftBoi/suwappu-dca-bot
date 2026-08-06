import { describe, expect, test } from "bun:test";
import { resolveExecutionMode } from "../src/execution.js";

describe("DCA execution gate", () => {
  test("defaults to preview even if execution credentials are present", () => {
    expect(
      resolveExecutionMode({
        execute: false,
        allowManagedExecution: "1",
        walletAddress: "0xabc",
      }),
    ).toEqual({ kind: "preview" });
  });

  test("requires an independent environment opt-in", () => {
    expect(() =>
      resolveExecutionMode({
        execute: true,
        walletAddress: "0xabc",
      }),
    ).toThrow("SUWAPPU_ALLOW_MANAGED_EXECUTION=1");
  });

  test("requires a wallet for quote-bound simulation", () => {
    expect(() =>
      resolveExecutionMode({
        execute: true,
        allowManagedExecution: "1",
      }),
    ).toThrow("SUWAPPU_WALLET_ADDRESS");
  });

  test("enables managed execution only when both gates are explicit", () => {
    expect(
      resolveExecutionMode({
        execute: true,
        allowManagedExecution: "1",
        walletAddress: "0xabc",
      }),
    ).toEqual({ kind: "managed", walletAddress: "0xabc" });
  });
});
