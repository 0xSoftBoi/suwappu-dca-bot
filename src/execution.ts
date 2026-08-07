import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  executeManagedSwap,
  getManagedSwapStatus,
  isFailedSwapStatus,
  isSuccessfulSwapStatus,
  simulateSwap,
  SuwappuRequestError,
} from "./suwappu.js";

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
    throw new Error("SUWAPPU_WALLET_ADDRESS is required for wallet-bound quote simulation.");
  }
  return { kind: "managed", walletAddress: options.walletAddress };
}

export type ExecutionPhase =
  | "preview"
  | "prepared"
  | "submitting"
  | "submitted"
  | "completed"
  | "failed"
  | "outcome_unknown";

export interface EconomicTerms {
  fromToken: string;
  toToken: string;
  amount: string;
  chain: string;
}

export interface ExecutionIntent {
  id: string;
  planId: string;
  actionKey: string;
  phase: ExecutionPhase;
  terms: EconomicTerms;
  maxGasUsd: number;
  quoteId?: string;
  quotedToAmount?: string;
  quotedToAmountMin?: string;
  estimatedGasUsd?: number;
  reportedRouteFeeUsd?: number;
  swapId?: string;
  swapStatus?: string;
  txHash?: string;
  actualFromAmount?: string;
  actualToAmount?: string;
  warnings?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteForExecution {
  id: string;
  toAmount: string;
  toAmountMin: string;
  estimatedGasUsd: number;
  reportedRouteFeeUsd: number | null;
}

const EXECUTION_PHASES = new Set<ExecutionPhase>([
  "preview",
  "prepared",
  "submitting",
  "submitted",
  "completed",
  "failed",
  "outcome_unknown",
]);
const BLOCKING_PHASES = new Set<ExecutionPhase>([
  "prepared",
  "submitting",
  "submitted",
  "outcome_unknown",
]);
const TERMINAL_PHASES = new Set<ExecutionPhase>(["completed", "failed"]);

function stateDir(): string {
  return process.env.SUWAPPU_DCA_STATE_DIR ?? join(homedir(), ".suwappu-dca");
}

function journalFile(): string {
  return join(stateDir(), "execution-journal.json");
}

function isExecutionIntent(value: unknown): value is ExecutionIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<ExecutionIntent>;
  const terms = intent.terms as Partial<EconomicTerms> | undefined;
  return typeof intent.id === "string"
    && typeof intent.planId === "string"
    && typeof intent.actionKey === "string"
    && typeof intent.phase === "string"
    && EXECUTION_PHASES.has(intent.phase as ExecutionPhase)
    && !!terms
    && typeof terms.fromToken === "string"
    && typeof terms.toToken === "string"
    && typeof terms.amount === "string"
    && typeof terms.chain === "string"
    && typeof intent.maxGasUsd === "number"
    && Number.isFinite(intent.maxGasUsd)
    && intent.maxGasUsd > 0
    && typeof intent.createdAt === "string"
    && typeof intent.updatedAt === "string";
}

function loadJournal(): ExecutionIntent[] {
  if (!existsSync(journalFile())) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(journalFile(), "utf8"));
  } catch (error) {
    throw new Error(
      `Execution journal is unreadable; refusing a new economic action: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || !parsed.every(isExecutionIntent)) {
    throw new Error("Execution journal is invalid; refusing a new economic action");
  }
  return parsed;
}

function saveJournal(entries: ExecutionIntent[]): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = journalFile();
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries, null, 2));
  renameSync(temporary, target);
}

function saveEntry(entry: ExecutionIntent): void {
  const entries = loadJournal();
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  const existing = index >= 0 ? entries[index] : undefined;
  if (existing && TERMINAL_PHASES.has(existing.phase) && existing.phase !== entry.phase) {
    // A late status/retry response must never regress or rewrite an already
    // terminal outcome. Mutate the caller's object too so its return value is
    // consistent with the durable authority.
    Object.assign(entry, existing);
    return;
  }
  if (existing && TERMINAL_PHASES.has(existing.phase)) {
    entry.actualFromAmount ??= existing.actualFromAmount;
    entry.actualToAmount ??= existing.actualToAmount;
    entry.txHash ??= existing.txHash;
  }
  entry.updatedAt = new Date().toISOString();
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  // Never prune unresolved idempotency records. Production systems should move
  // this append-only history to transactional storage rather than dropping it.
  saveJournal(entries);
}

function sameTerms(a: EconomicTerms, b: EconomicTerms): boolean {
  return a.fromToken.toUpperCase() === b.fromToken.toUpperCase()
    && a.toToken.toUpperCase() === b.toToken.toUpperCase()
    && a.chain.toLowerCase() === b.chain.toLowerCase()
    && a.amount === b.amount;
}

function makeIntentId(planId: string): string {
  const compactPlan = planId.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 24);
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `dca.${compactPlan}.${Date.now().toString(36)}.${random}`.slice(0, 64);
}

function currentIntent(planId: string, actionKey: string): ExecutionIntent | undefined {
  return loadJournal().slice().reverse().find((intent) => (
    intent.planId === planId && intent.actionKey === actionKey
  ));
}

export function getBlockingExecution(planId: string): ExecutionIntent | undefined {
  return loadJournal().slice().reverse().find((intent) => (
    intent.planId === planId && BLOCKING_PHASES.has(intent.phase)
  ));
}

export function listExecutionJournal(limit = 100): ExecutionIntent[] {
  return loadJournal().slice(-Math.max(1, limit)).reverse();
}

function applyStatus(
  intent: ExecutionIntent,
  status: Awaited<ReturnType<typeof getManagedSwapStatus>>,
): void {
  intent.swapId = status.swapId;
  intent.swapStatus = status.status;
  intent.txHash = status.txHash ?? intent.txHash;
  intent.actualFromAmount = status.fromAmount ?? intent.actualFromAmount;
  intent.actualToAmount = status.toAmount ?? intent.actualToAmount;
  intent.error = status.errorMessage ?? undefined;
  if (isSuccessfulSwapStatus(status.status)) intent.phase = "completed";
  else if (isFailedSwapStatus(status.status)) intent.phase = "failed";
  else intent.phase = "submitted";
}

async function reconcileKnownSwap(apiKey: string, intent: ExecutionIntent): Promise<ExecutionIntent> {
  if (!intent.swapId) return intent;
  try {
    const status = await getManagedSwapStatus(apiKey, intent.swapId);
    applyStatus(intent, status);
    saveEntry(intent);
  } catch (error) {
    intent.error = `Reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}`;
    saveEntry(intent);
  }
  return intent;
}

/** Poll known swap IDs only. Never creates a quote or submits an economic action. */
export async function reconcileExecutionJournal(apiKey: string): Promise<ExecutionIntent[]> {
  const entries = loadJournal();
  for (const intent of entries) {
    const needsFinalAmounts = intent.phase === "completed"
      && (!intent.actualFromAmount || !intent.actualToAmount);
    if (!intent.swapId || (!BLOCKING_PHASES.has(intent.phase) && !needsFinalAmounts)) continue;
    await reconcileKnownSwap(apiKey, intent);
  }
  return listExecutionJournal(entries.length || 1);
}

export function recordPreview(args: {
  planId: string;
  actionKey: string;
  terms: EconomicTerms;
  maxGasUsd: number;
  quote: QuoteForExecution;
}): ExecutionIntent {
  const existing = currentIntent(args.planId, args.actionKey);
  if (existing) return existing;
  const now = new Date().toISOString();
  const intent: ExecutionIntent = {
    id: makeIntentId(args.planId),
    planId: args.planId,
    actionKey: args.actionKey,
    phase: "preview",
    terms: args.terms,
    maxGasUsd: args.maxGasUsd,
    quoteId: args.quote.id,
    quotedToAmount: args.quote.toAmount,
    quotedToAmountMin: args.quote.toAmountMin,
    estimatedGasUsd: args.quote.estimatedGasUsd,
    ...(args.quote.reportedRouteFeeUsd !== null
      ? { reportedRouteFeeUsd: args.quote.reportedRouteFeeUsd }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  saveEntry(intent);
  return intent;
}

export function recordFailure(args: {
  planId: string;
  actionKey: string;
  terms: EconomicTerms;
  maxGasUsd: number;
  error: string;
}): ExecutionIntent {
  const existing = currentIntent(args.planId, args.actionKey);
  if (existing) return existing;
  const now = new Date().toISOString();
  const intent: ExecutionIntent = {
    id: makeIntentId(args.planId),
    planId: args.planId,
    actionKey: args.actionKey,
    phase: "failed",
    terms: args.terms,
    maxGasUsd: args.maxGasUsd,
    error: args.error,
    createdAt: now,
    updatedAt: now,
  };
  saveEntry(intent);
  return intent;
}

export async function runManagedExecution(args: {
  apiKey: string;
  planId: string;
  actionKey: string;
  terms: EconomicTerms;
  maxGasUsd: number;
  walletAddress: string;
  getQuote: () => Promise<QuoteForExecution>;
}): Promise<ExecutionIntent> {
  let intent = currentIntent(args.planId, args.actionKey);

  if (intent && !sameTerms(intent.terms, args.terms)) {
    throw new Error(`DCA intent ${intent.id} has different economic terms for the same action key`);
  }
  if (intent?.phase === "preview") {
    throw new Error(`Action ${args.actionKey} was already recorded as preview-only`);
  }
  if (intent?.phase === "completed" || intent?.phase === "failed") return intent;
  if (intent?.swapId) return reconcileKnownSwap(args.apiKey, intent);

  if (!intent) {
    const now = new Date().toISOString();
    intent = {
      id: makeIntentId(args.planId),
      planId: args.planId,
      actionKey: args.actionKey,
      phase: "prepared",
      terms: args.terms,
      maxGasUsd: args.maxGasUsd,
      createdAt: now,
      updatedAt: now,
    };
    saveEntry(intent);
  }

  const hadSubmissionRisk = intent.phase === "submitting" || intent.phase === "outcome_unknown";
  let quote: QuoteForExecution;
  try {
    quote = await args.getQuote();
  } catch (error) {
    intent.phase = hadSubmissionRisk ? "outcome_unknown" : "failed";
    intent.error = `Quote unavailable${hadSubmissionRisk ? " while an earlier submission may have executed" : ""}: ${error instanceof Error ? error.message : String(error)}`;
    saveEntry(intent);
    return intent;
  }

  intent.quoteId = quote.id;
  intent.quotedToAmount = quote.toAmount;
  intent.quotedToAmountMin = quote.toAmountMin;
  intent.estimatedGasUsd = quote.estimatedGasUsd;
  if (quote.reportedRouteFeeUsd !== null) intent.reportedRouteFeeUsd = quote.reportedRouteFeeUsd;
  saveEntry(intent);

  let simulation: Awaited<ReturnType<typeof simulateSwap>>;
  try {
    simulation = await simulateSwap(args.apiKey, quote.id, args.walletAddress);
  } catch (error) {
    intent.phase = hadSubmissionRisk ? "outcome_unknown" : "failed";
    intent.error = `Simulation unavailable${hadSubmissionRisk ? " while an earlier submission may have executed" : ""}: ${error instanceof Error ? error.message : String(error)}`;
    saveEntry(intent);
    return intent;
  }
  intent.warnings = simulation.warnings;
  if (!simulation.wouldExecute) {
    const warnings = simulation.warnings.length ? `: ${simulation.warnings.join("; ")}` : "";
    intent.phase = hadSubmissionRisk ? "outcome_unknown" : "failed";
    intent.error = hadSubmissionRisk
      ? `Retry simulation blocked while an earlier submission may have executed${warnings}`
      : `Simulation blocked execution${warnings}`;
    saveEntry(intent);
    return intent;
  }

  intent.phase = "submitting";
  intent.error = undefined;
  saveEntry(intent);

  try {
    const swap = await executeManagedSwap(args.apiKey, quote.id, { idempotencyKey: intent.id });
    intent.swapId = swap.swapId;
    intent.swapStatus = swap.status;
    intent.txHash = swap.txHash;
    intent.phase = isSuccessfulSwapStatus(swap.status)
      ? "completed"
      : isFailedSwapStatus(swap.status)
        ? "failed"
        : "submitted";
    saveEntry(intent);
    if (intent.swapId && intent.phase === "completed") {
      intent = await reconcileKnownSwap(args.apiKey, intent);
    }
  } catch (error) {
    intent.phase = error instanceof SuwappuRequestError && !error.outcomeUnknown
      ? "failed"
      : "outcome_unknown";
    intent.error = error instanceof Error ? error.message : String(error);
    saveEntry(intent);
  }
  return intent;
}
