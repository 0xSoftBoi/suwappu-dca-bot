export type ExecutionMode =
  | { kind: "preview" }
  | { kind: "managed"; walletAddress: string };

export function resolveExecutionMode(options: {
  execute: boolean;
  allowManagedExecution?: string;
  walletAddress?: string;
}): ExecutionMode {
  if (!options.execute) return { kind: "preview" };

  if (options.allowManagedExecution !== "1") {
    throw new Error(
      "Managed execution is locked. Set SUWAPPU_ALLOW_MANAGED_EXECUTION=1 as well as --execute.",
    );
  }

  if (!options.walletAddress) {
    throw new Error(
      "SUWAPPU_WALLET_ADDRESS is required for wallet-bound quote simulation.",
    );
  }

  return { kind: "managed", walletAddress: options.walletAddress };
}
