---
name: suwappu-dca
description: Preview, run, and inspect fixed-USDC recurring Suwappu purchase plans with explicit schedule, gas, execution, idempotency, and reconciliation boundaries
user-invocable: true
tools:
  - start_dca
  - dca_status
  - dca_history
  - run_once
metadata:
  openclaw.primaryEnv: SUWAPPU_API_KEY
  openclaw.emoji: "📅"
  openclaw.category: defi
  openclaw.tags: ["dca", "trading", "scheduling", "defi", "automation"]
---

# Suwappu DCA

Treat recurring purchase plans as durable economic intent, not as permission to fire a swap whenever cron calls back.

## Default authority

- Preview unless the user explicitly requests managed execution.
- Require both `--execute` and `SUWAPPU_ALLOW_MANAGED_EXECUTION=1` for managed mode.
- Require `SUWAPPU_WALLET_ADDRESS` for a managed wallet-aware quote/simulation.
- Never infer execution authority from an API key, funded wallet, enabled schedule, or prior live run.
- Use Suwappu's unsigned transaction preparation path for self-custody rather than this scheduler's managed endpoint.
- Require an API key only for network operations. Local plan status and plain journal history must remain inspectable without credentials.

## Plan contract

Require:

- stable explicit plan `id`;
- `fromToken: USDC` so amount/caps have fixed-dollar meaning;
- positive `amount` at/below `SUWAPPU_MAX_DCA_USDC`;
- non-USDC destination and explicit chain;
- valid five-field cron with one literal minute (no sub-hour cadence);
- explicit IANA timezone or the implementation's `UTC` default;
- positive `maxGasUsd` no larger than the action amount.

Treat one plan + local wall-clock schedule slot as one economic action. Do not create a second action for a repeated DST wall-clock slot.

## Preview

Request a fresh route and require valid input/output/minimum output, gas estimate, and useful TTL. Refuse promotion when `estimated_gas_usd > maxGasUsd`.

Record preview/failed outcomes in the durable journal. Do not submit.

## Managed execution

Preserve this order:

```text
persist intent
  -> fresh wallet-aware quote + gas/TTL guard
  -> /swap/simulate with would_execute === true
  -> re-check quote TTL after simulation
  -> persist submitting
  -> /swap/execute with intent ID as Idempotency-Key
  -> reconcile known swap ID to terminal status/final amounts
```

An HTTP/top-level `success: true` simulation is insufficient when `would_execute` is false.

Treat timeout, network failure after write, HTTP 408/5xx, or malformed successful execute response as `outcome_unknown`. Retry the same economic terms only with the same persisted idempotency key.

If a plan has a `prepared`, `submitting`, `submitted`, or `outcome_unknown` action, recover that action before a fresh schedule installment. A known swap ID is poll-only; never resubmit it.

## Tools

### `start_dca`

Start validated schedules in preview mode by default. In managed mode, keep background status reconciliation read-only and preserve the durable journal across restarts.

### `dca_status`

Show plan ID, USDC amount, destination, chain, cron, timezone, gas ceiling, and enabled state. This is local validation: do not require an API key and do not make a network request.

### `dca_history`

Show distinct `preview`, `prepared`, `submitting`, `submitted`, `completed`, `failed`, and `outcome_unknown` states. Plain history is local and credential-free. Reconciliation may poll known swap IDs but must never create a quote or submit.

### `run_once`

Preview one fixed-USDC action by default. Require an explicit gas ceiling. If an earlier manual action is unresolved, recover it instead of silently creating another one.

## State safety

Keep `execution-journal.json` durable. Never delete an unresolved intent to clear an error. CLI write sessions acquire `execution.lock`; never auto-delete a stale lock, and only clear one after proving the recorded owner is gone. The journal uses owner-only permissions, atomic replacement, and a soft retention target that never prunes completed/unresolved execution evidence.

Use `SUWAPPU_OPERATION_TIMEOUT_MS` to keep operations bounded. If `SUWAPPU_API_EVENTS` is enabled, emit metadata only: operation/outcome/duration/status, never keys, wallet/market terms, quote/swap IDs, response bodies, or error text.

Strictly bind returned quote tokens, simulation quote ID, managed-execute success, and status swap ID to the request. A parseable/HTTP-successful response is not by itself execution proof.

For multiple hosts/replicas, replace local JSON/locking with transactional storage plus uniqueness on tenant + plan + schedule slot and distributed serialization.

Use server-side wallet policies as an independent limit; client cron/amount/gas checks are defense in depth.

Builder/product docs: https://docs.suwappu.bot and `BUILDING_A_PRODUCT.md`. Sell workflow, control, history, approvals, and bounded automation—not promised investment returns.
