# Suwappu DCA Bot

An outcome-safe reference for building fixed-dollar recurring purchase products on [Suwappu](https://suwappu.bot).

This repository focuses on the hard part of DCA automation: turning one scheduled wall-clock slot into at most one durable economic action, then following that action through quote, permission, idempotent submission, and terminal reconciliation.

> This is an integration reference, not a claim that DCA is profitable or financial advice. It does not choose assets, predict returns, or guarantee that a recurring plan will outperform another allocation.

## What this teaches

| Builder problem | Pattern in this repo |
|---|---|
| “DCA” amount is ambiguous | This reference accepts USDC only, so plan amounts/caps are fixed-dollar accounting |
| Cron fires twice or a DST hour repeats | Stable plan ID + local wall-clock schedule-slot key dedupes the action |
| Process restarts after a money-moving request | Atomic durable intent exists before submission risk |
| Execute response times out | Preserve `outcome_unknown` and retry only with the original `Idempotency-Key` |
| Old swap is still pending at the next slot | The unresolved action owns the plan; reconcile/recover it and skip the new installment |
| Quote is technically valid but uneconomic | Require `estimated_gas_usd <= maxGasUsd` and useful quote TTL |
| Simulation request returned HTTP 200 | Still require `would_execute === true` |
| Submission looks successful | Poll status and keep final amounts distinct from quoted amounts |

If you are turning the scheduler into a paid product, continue with [BUILDING_A_PRODUCT.md](BUILDING_A_PRODUCT.md).

## Safe execution model

| Mode | Enter it | Can submit? |
|---|---|---:|
| Preview | default | No |
| Managed | `--execute` **and** `SUWAPPU_ALLOW_MANAGED_EXECUTION=1` | Yes |
| Self-custody | not implemented here | No; use Suwappu's unsigned transaction flow |

Managed mode also requires `SUWAPPU_WALLET_ADDRESS`. API credentials, a wallet, or an enabled plan do not silently grant transaction authority.

## Quick start

Requires Bun 1.3.14 or newer.

```bash
git clone https://github.com/0xSoftBoi/suwappu-dca-bot.git
cd suwappu-dca-bot
bun install --frozen-lockfile

curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name":"my-dca-bot"}'

export SUWAPPU_API_KEY=suwappu_sk_...

mkdir -p ~/.suwappu-dca
cp examples/dca-config.example.json ~/.suwappu-dca/config.json

# Every scheduled trigger is quote-only preview.
bun src/index.ts start
```

The plan file never loads an API key. Keep credentials in environment/secret management, not alongside schedule configuration.

## Plan configuration

```json
{
  "plans": [
    {
      "id": "daily-eth",
      "name": "Daily ETH",
      "fromToken": "USDC",
      "toToken": "ETH",
      "amount": 50,
      "chain": "base",
      "schedule": "0 9 * * *",
      "timezone": "America/New_York",
      "maxGasUsd": 2
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | Yes | Stable 1–40 character plan identity; never derive it from array position |
| `name` | Yes | Human label |
| `fromToken` | Yes | Must be `USDC` in this fixed-dollar reference |
| `toToken` | Yes | Non-USDC asset to acquire |
| `amount` | Yes | USDC per scheduled economic action |
| `chain` | Yes | Chain used for the executable quote |
| `schedule` | Yes | 5-field cron; minute must be one literal `0`–`59`, so cadence is no faster than hourly |
| `timezone` | No | IANA zone; defaults to `UTC` rather than host-local time |
| `maxGasUsd` | Yes | Maximum quote gas estimate this plan may promote |
| `enabled` | No | Defaults to `true` |

`SUWAPPU_MAX_DCA_USDC` is an independent per-action client ceiling and defaults to `1000`. A plan over the cap, a missing/invalid gas ceiling, non-USDC source, invalid timezone, duplicate/unstable ID, sub-hour cron, malformed quote, missing gas estimate, or nearly expired quote fails closed.

Client limits are defense in depth. Configure restrictive managed-wallet policies for durable asset/spend controls.

## One schedule slot = one economic action

At each cron trigger the scheduler computes an action key from the plan's **local wall-clock minute**. For example:

```text
plan: daily-eth
timezone: America/New_York
slot: 2026-11-01 01:30
action: schedule.20261101T0130
```

If the 01:30 wall-clock hour repeats during the daylight-saving fallback, both callbacks resolve to the same action key. The durable journal therefore cannot turn that repeated wall-clock slot into two DCA economic actions.

The scheduler intentionally does not backfill a slot it completely missed while offline. Production catch-up policy is a product decision; adding an automatic “buy everything we missed” loop is not a safe default.

## Preview and cost guard

Preview mode requests the real chain route but stops before simulation/submission. It records:

- requested USDC amount;
- quote ID and optimistic/minimum output;
- estimated gas and the plan ceiling;
- reported route-fee attribution;
- plan/action identity.

A route is previewable/promotable only when gas is present, `estimated_gas_usd <= maxGasUsd`, and more than five seconds of quote TTL remain. `amount_out_min` is retained because minimum output—not optimistic output—is the useful execution bound.

## Enabling managed DCA

Set the intended wallet and the independent live environment gate, then add `--execute`:

```bash
export SUWAPPU_WALLET_ADDRESS=0x...
export SUWAPPU_ALLOW_MANAGED_EXECUTION=1
export SUWAPPU_MAX_DCA_USDC=100

bun src/index.ts start --execute
```

For each new scheduled action, the managed path:

1. persists the exact plan/action/economic terms;
2. obtains a fresh wallet-aware quote and applies the gas/TTL guard;
3. calls `/swap/simulate` and requires **`would_execute: true`**;
4. persists `submitting` before the network request;
5. sends the durable intent ID as `Idempotency-Key` to `/swap/execute`;
6. records a known swap ID and reconciles `/swap/status/:id` once per minute while the scheduler is running;
7. stores terminal status and final amounts when available.

An HTTP-successful simulation can still say `would_execute: false`. That is a block, not permission.

### Ambiguous execution never becomes a fresh installment

A timeout, dropped connection after write, 5xx, or malformed successful execute response can mean the transaction happened but its response was lost. The scheduler records `outcome_unknown`.

If the next scheduled trigger finds any `prepared`, `submitting`, `submitted`, or `outcome_unknown` action for that plan, the old action wins. The scheduler recovers/reconciles it and conservatively skips the new installment. An ambiguous action without a swap ID gets a fresh same-terms quote + simulation and retries using the **same** idempotency key.

This is intentionally stricter than “cron fired, therefore buy again.”

## One-off actions

`run-once` is preview-only unless the same two live gates are present:

```bash
bun src/index.ts run-once \
  --to ETH \
  --amount 50 \
  --chain base \
  --max-gas-usd 2

# Explicit managed version:
bun src/index.ts run-once \
  --to ETH \
  --amount 50 \
  --chain base \
  --max-gas-usd 2 \
  --execute
```

Manual actions share one `manual` recovery lane. If a previous manual submit is unresolved, a later manual command recovers it instead of silently creating a second action.

## Durable history and reconciliation

```bash
bun src/index.ts history
bun src/index.ts history --reconcile
```

The journal distinguishes `preview`, `prepared`, `submitting`, `submitted`, `completed`, `failed`, and `outcome_unknown`. `--reconcile` polls known swap IDs only; it never quotes or submits.

By default the journal is `~/.suwappu-dca/execution-journal.json`; override its directory with `SUWAPPU_DCA_STATE_DIR`. Writes are atomic. Do not delete unresolved records to “unstick” a plan: losing an idempotency key can turn recovery into a second economic action.

This local journal assumes one process owns the state directory. Before horizontal scaling, move intents to transactional durable storage with uniqueness/locking around plan/action keys.

## Commands

| Command | Purpose |
|---|---|
| `start` | Validate and schedule all enabled plans; preview by default |
| `status` | Validate/show plan amount, cadence, timezone, gas ceiling, enabled state |
| `history` | Show the durable action journal; optional read-only reconciliation |
| `run-once` | Preview one fixed-USDC action; add `--execute` for managed submission |

## Suwappu authority boundary

`src/suwappu.ts` is a small typed adapter over the production quote, simulation, managed execute, and status contracts this example actually needs. That keeps the example independent of registry-release timing while still making the API boundary explicit.

Suwappu's hosted MCP endpoint is `https://api.suwappu.bot/mcp`. Its historically named `execute_swap` flow prepares an unsigned/self-custody transaction; it is not the managed `/swap/execute` endpoint used by this scheduler. Keep “prepare for a wallet to sign” separate from “submit from a managed wallet.”

## How this stacks up

This repository should stay a small Suwappu recurring-action reference.

| Project | What it demonstrates | What builders should copy |
|---|---|---|
| This repository | Scheduled fixed-USDC Suwappu actions with durable recovery | plan/slot identity, cost gate, permission, idempotency, reconciliation |
| [Hummingbot DCAExecutor](https://hummingbot.org/strategies/v2-strategies/executors/dcaexecutor/) | A DCA Executor with its own order/execution lifecycle | Move to an executor/controller architecture when one recurring swap becomes multi-order strategy state |
| [Freqtrade position adjustment](https://www.freqtrade.io/en/stable/strategy-callbacks/) | DCA-style position adjustment inside a full strategy system | Use strict re-entry logic/limits; its docs explicitly warn loose logic can place repeated entries very quickly |

Suwappu is the financial action plane here. Use a deeper trading framework when the problem becomes strategy research, position lifecycle, exits, or many-order orchestration.

## Develop

```bash
bun run typecheck
bun test
```

CI uses Bun 1.3.14, a frozen lockfile, blocking typecheck, and regression tests for schedule identity, caps/gas, `would_execute`, durable journal corruption, same-key ambiguous retry, known-swap reconciliation, and final amounts.

## Build further

- [Turn recurring execution into a product](BUILDING_A_PRODUCT.md)
- [Suwappu docs](https://docs.suwappu.bot)
- [Managed wallets](https://docs.suwappu.bot/guides/managed-wallets)
- [Strategy lifecycle](https://docs.suwappu.bot/guides/strategy-lifecycle)
- [SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)

Discover supported chains/tokens at runtime instead of hard-coding a chain/provider count that will go stale.

## License

[MIT](LICENSE)
