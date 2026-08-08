# Operations Runbook

This runbook is for the standalone Suwappu DCA Bot v2. The product contract is one bounded fixed-USDC economic action per plan/local wall-clock slot, with explicit execution authority and durable reconciliation.

## Authority modes

| Command | Network | Can submit | Writes journal |
|---|---:|---:|---:|
| `status` | No | No | No |
| `history` | No | No | No |
| `start` | Quotes when due; status for known swaps | No | Yes |
| `run-once` | Quote | No | Yes |
| `start --execute` / `run-once --execute` + env gate | Quote, simulate, execute, status | **Yes** | **Yes** |
| `history --reconcile` | Known-swap status only | No new submission | **Yes** |

Managed mode additionally requires `SUWAPPU_WALLET_ADDRESS`. Keep restrictive server-side wallet policies in force; `SUWAPPU_MAX_DCA_USDC` and plan gas ceilings are defense in depth.

## Before live operation

1. Validate the exact release and plan file with `bun src/index.ts status --config <path>`; this command needs no API key.
2. Run a small `run-once` preview on the intended chain/pair.
3. Confirm managed-wallet policy, balances/gas, intended API identity, timezone, cadence, amount, and gas ceiling.
4. Put `SUWAPPU_DCA_STATE_DIR` on app-exclusive durable local storage and back it up before upgrades.
5. Inspect `bun src/index.ts history` and resolve any action you do not understand.
6. Confirm no stale `execution.lock` exists.
7. Set a deliberately small `SUWAPPU_MAX_DCA_USDC` and enable `SUWAPPU_API_EVENTS=1` only if your log sink can safely retain metadata events.
8. Start managed scheduling only after both `--execute` and `SUWAPPU_ALLOW_MANAGED_EXECUTION=1` are intentionally present.

Do not hide managed scheduling behind an unconditional restart policy. The supplied container/Compose contract performs local plan validation and exits; scheduling is an explicit command override.

## Durable state and one local owner

The state directory contains:

- `execution-journal.json`: plan/action identity, economic terms, route evidence, submission/reconciliation state, and final amounts;
- `execution.lock`: exclusive ownership for any CLI session that may write the journal.

Directory mode is `0700`; journal/lock mode is `0600`. Journal replacement uses a unique temporary file, file `fsync`, atomic rename, and best-effort directory `fsync`. Invalid JSON fails closed before a fresh economic action.

`SUWAPPU_DCA_JOURNAL_LIMIT` defaults to 5,000 records. It is a soft target: only preview records are automatically disposable. Failed/completed actions and unresolved `prepared`, `submitting`, `submitted`, or `outcome_unknown` records are retained even if the file grows past the target.

### Stale-lock recovery

The bot intentionally does not guess that a lock is stale.

1. Stop schedulers/supervisors for this state directory.
2. Inspect `execution.lock` and note `pid` and `acquiredAt`.
3. Prove that process is gone and no other host can own this local directory.
4. Preserve the journal/lock as incident evidence.
5. Remove only that proven-stale lock.
6. Run `history --reconcile` before re-enabling managed scheduling.

If ownership cannot be proved, stop. For multiple replicas, replace local JSON/locking with transactional state, uniqueness on tenant + plan + schedule slot, and distributed serialization.

## Schedule semantics

Each plan has a stable ID and an IANA timezone. A due action is keyed from the local wall-clock minute, so a repeated DST fall-back slot resolves to the same economic action. The reference does not catch up slots completely missed while offline.

An unresolved prior action owns its plan. A later schedule tick recovers/reconciles the earlier action and skips its own installment rather than stacking new intent. Material plan edits do not mutate already-durable terms.

## Outcome-unknown recovery

Before `/swap/execute`, the bot persists `submitting` and sends the durable intent ID as `Idempotency-Key`. Network/timeout failure, HTTP 408/5xx, or malformed successful execute response may happen after a side effect begins, so these cases are `outcome_unknown`.

- known `swapId`: status-reconcile it; never submit it again;
- no `swapId`: retain the original terms/key, obtain a fresh same-terms quote, re-run simulation/guards, then reuse the same key;
- different desired terms: wait until the unresolved original is reconciled before creating a fresh installment.

Do not repair an incident by deleting unresolved state or minting a new idempotency key.

## Network deadlines and telemetry

`SUWAPPU_OPERATION_TIMEOUT_MS` defaults to 25,000ms and must be between 100 and 30,000ms. A managed execute timeout is never proof of failure.

With `SUWAPPU_API_EVENTS=1`, stderr receives metadata records such as:

```text
suwappu_api_event {"operation":"quote","outcome":"response_ok","duration_ms":184.2,"status":200}
```

Events exclude keys, wallet/market terms, quote/swap IDs, response bodies, and error text. Alert on sustained timeouts/rate limits, long-lived ambiguous actions, reconciliation lag, and duplicate economic actions (target: zero).

## Cost budget and customer reporting

A preview slot normally costs one quote call. A fresh managed slot adds simulation + execute, then status reads until terminal; ambiguous recovery adds a fresh same-terms quote + simulation + same-key retry.

Convert those measured calls to money using the current Suwappu pricing contract. Keep builder contribution margin separate from customer asset performance, and expose the customer-facing facts: scheduled slot, authorized amount/asset/chain, gas ceiling, simulation result, submission state, and final reconciled amounts.

## Release gate

Before merging or deploying a money-path change:

```bash
bun install --frozen-lockfile
bun run verify
```

CI also validates the non-root container contract and runs CodeQL. Treat changes to `src/execution.ts`, `src/suwappu.ts`, schedule identity, live CLI gates, or state migration as money-path changes and add regression coverage.

## Scope and graduation

This repo is intentionally a Suwappu recurring-intent product reference, not a complete strategy platform. Graduate to a deeper executor/controller or trading framework when you need multi-order strategy state, exits, backtesting, or portfolio risk; keep Suwappu as the bounded action plane.
