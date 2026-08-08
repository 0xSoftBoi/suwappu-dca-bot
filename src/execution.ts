import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  expiresAtMs: number;
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

function lockFile(): string {
  return join(stateDir(), "execution.lock");
}

function ensureStateDir(): string {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function journalLimit(): number {
  const value = Number(process.env.SUWAPPU_DCA_JOURNAL_LIMIT ?? "5000");
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error(
      "SUWAPPU_DCA_JOURNAL_LIMIT must be an integer between 1 and 100000",
    );
  }
  return value;
}

function applyJournalRetention(entries: ExecutionIntent[]): ExecutionIntent[] {
  let excess = entries.length - journalLimit();
  if (excess <= 0) return entries;

  // This is deliberately a soft target. Only preview-only evidence is
  // disposable; failed/completed/unresolved execution records are retained.
  return entries.filter((intent) => {
    const safelyDisposable = intent.phase === "preview";
    if (excess > 0 && safelyDisposable) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isExecutionIntent(value: unknown): value is ExecutionIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<ExecutionIntent>;
  const terms = intent.terms as Partial<EconomicTerms> | undefined;
  const amount = Number(terms?.amount);
  return typeof intent.id === "string"
    && intent.id.length > 0
    && typeof intent.planId === "string"
    && intent.planId.length > 0
    && typeof intent.actionKey === "string"
    && intent.actionKey.length > 0
    && typeof intent.phase === "string"
    && EXECUTION_PHASES.has(intent.phase as ExecutionPhase)
    && !!terms
    && typeof terms.fromToken === "string" && terms.fromToken.length > 0
    && typeof terms.toToken === "string" && terms.toToken.length > 0
    && typeof terms.amount === "string"
    && Number.isFinite(amount) && amount > 0
    && typeof terms.chain === "string" && terms.chain.length > 0
    && typeof intent.maxGasUsd === "number"
    && Number.isFinite(intent.maxGasUsd)
    && intent.maxGasUsd > 0
    && typeof intent.createdAt === "string" && intent.createdAt.length > 0
    && typeof intent.updatedAt === "string" && intent.updatedAt.length > 0
    && optionalString(intent.quoteId)
    && optionalString(intent.quotedToAmount)
    && optionalString(intent.quotedToAmountMin)
    && optionalNonNegativeNumber(intent.estimatedGasUsd)
    && optionalNonNegativeNumber(intent.reportedRouteFeeUsd)
    && optionalString(intent.swapId)
    && optionalString(intent.swapStatus)
    && optionalString(intent.txHash)
    && optionalString(intent.actualFromAmount)
    && optionalString(intent.actualToAmount)
    && optionalString(intent.error)
    && (intent.warnings === undefined
      || (Array.isArray(intent.warnings) && intent.warnings.every((warning) => typeof warning === "string")));
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
  const dir = ensureStateDir();
  const target = journalFile();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(applyJournalRetention(entries), null, 2), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync is unavailable on some filesystems/platforms.
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export class ExecutionLockError extends Error {
  constructor(readonly path: string) {
    super(
      `Execution lock ${path} already exists; another journal writer may be active. Prove the owning process is gone before clearing a stale lock`,
    );
    this.name = "ExecutionLockError";
  }
}

/**
 * Own the local journal for a scheduler/run/reconciliation write session.
 * Release verifies an ownership token so it never deletes a replacement lock.
 */
export function acquireExecutionLock(): () => void {
  journalLimit();
  ensureStateDir();
  const path = lockFile();
  const ownerToken = randomUUID();
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ExecutionLockError(path);
    }
    throw error;
  }

  try {
    writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      ownerToken,
    }), "utf8");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    if (existsSync(path)) unlinkSync(path);
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    if (!existsSync(path)) return;
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as { ownerToken?: unknown };
      if (current.ownerToken === ownerToken) unlinkSync(path);
    } catch {
      // Never delete a lock whose current ownership cannot be proven.
    }
  };
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

  if (quote.expiresAtMs <= Date.now() + 5_000) {
    intent.phase = hadSubmissionRisk ? "outcome_unknown" : "failed";
    intent.error = hadSubmissionRisk
      ? "Retry quote expired after simulation while an earlier submission may have executed"
      : "Quote has 5 seconds or less remaining after simulation; refusing submission";
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
