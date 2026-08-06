# Suwappu DCA Bot

A preview-first recurring-buy example for builders using [Suwappu](https://suwappu.bot).

It combines cron scheduling with the current Suwappu quote → simulation → managed-execution lifecycle. By default, scheduled and one-off runs only request quotes; they cannot submit a transaction.

> This is an integration example, not financial advice. Start with a dedicated wallet, restrictive Suwappu wallet policies, and small source-token amounts.

## What this teaches

- Model recurring purchase plans independently from execution credentials.
- Give cron plans explicit IANA timezones instead of inheriting a container's timezone by accident.
- Prevent overlapping executions of the same plan.
- Bind a live quote to the intended wallet and simulate it before managed submission.
- Keep recurring automation previewable until the operator opts into execution twice.
- Record previews, submitted swaps, and failures as different outcomes.

Suwappu currently supports 14 chains; discover available chains/tokens from the API rather than hard-coding provider counts.

## Safe execution model

| Mode | How to enter it | Behavior |
|---|---|---|
| Preview | default | scheduled/one-off quotes only |
| Managed execution | `--execute` **and** `SUWAPPU_ALLOW_MANAGED_EXECUTION=1` | wallet-bound quote → simulation → managed submit |
| Self-custody | not implemented here | use Suwappu's unsigned transaction flow |

Managed mode also requires `SUWAPPU_WALLET_ADDRESS`. If simulation does not explicitly return `success: true`, no execution request is made.

## Quick start

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

# Preview every scheduled trigger. No transaction submission.
bun src/index.ts start
```

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
      "timezone": "America/New_York"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | recommended | Unique plan id; generated when omitted |
| `name` | yes | Human-readable name |
| `fromToken` | yes | Source token |
| `toToken` | yes | Target token |
| `amount` | yes | **Source-token units** per run |
| `chain` | yes | Chain for the quote/swap |
| `schedule` | yes | Standard 5-field cron expression |
| `timezone` | no | IANA timezone, e.g. `America/New_York`; otherwise host timezone |
| `enabled` | no | Defaults to `true` |

Despite the strategy name, `amount` is not inherently USD. `amount: 50` with `fromToken: "USDC"` means 50 USDC; with `fromToken: "ETH"` it means 50 ETH. A classic dollar-cost-averaging plan normally uses a dollar stablecoin as the source token.

Duplicate plan ids are rejected. If a scheduled callback is still running when the same plan triggers again, the overlapping run is skipped.

The every-minute expression `* * * * *` is disabled by this example. For real recurring execution, choose a deliberate cadence and configure server-side wallet policy limits as the durable safety boundary.

## One-off preview

```bash
bun src/index.ts run-once \
  --from USDC \
  --to ETH \
  --amount 50 \
  --chain base
```

This obtains and records a quote but does not submit it.

## Enabling managed DCA

Set the intended managed wallet and the independent environment opt-in, then pass `--execute`:

```bash
export SUWAPPU_WALLET_ADDRESS=0x...
export SUWAPPU_ALLOW_MANAGED_EXECUTION=1

# Scheduled live mode
bun src/index.ts start --execute

# One explicitly requested live run
bun src/index.ts run-once \
  --from USDC \
  --to ETH \
  --amount 50 \
  --chain base \
  --execute
```

Each live trigger:

1. gets a fresh quote with `wallet_address`;
2. simulates the quote for that wallet;
3. requires `success: true`;
4. sends the quote id to `POST /v1/agent/swap/execute`;
5. records the managed `swap_id`, status, and transaction hash when available.

The API may accept a managed swap before a transaction hash exists; use swap status/history in larger systems instead of treating “hash pending” as failure.

## Commands

| Command | Purpose |
|---|---|
| `start` | Run all enabled schedules; preview by default |
| `status` | Show plan amounts, schedules, and timezones |
| `history` | Show preview/submitted/failed outcomes |
| `run-once` | Preview one buy; add `--execute` for managed submission |

## Current SDK publication boundary

The npm package is currently `@suwappu/sdk@0.4.0`, while the Suwappu repository already contains newer 0.6 TypeScript SDK source. The older package's swap execution helper targets the previous execution contract, so this example uses a small typed adapter in `src/suwappu.ts` for today's production endpoints instead of claiming an unpublished SDK.

The newer SDK source expresses the same distinction directly:

```text
getQuote({ ..., walletAddress })
  → simulateSwap({ quoteId, walletAddress })
  → swap(quote)                         # managed execution

prepareSwap({ quoteId, walletAddress }) # unsigned/self-custody
```

The hosted MCP endpoint is `https://api.suwappu.bot/mcp`. Its `execute_swap` tool prepares an unsigned/self-custody transaction; it is not the managed execution step used by this scheduler.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `SUWAPPU_API_KEY` | Yes | Agent authentication |
| `SUWAPPU_WALLET_ADDRESS` | Managed mode | Wallet bound to quote + simulation |
| `SUWAPPU_ALLOW_MANAGED_EXECUTION` | Managed mode | Must equal `1` in addition to `--execute` |
| `SUWAPPU_API_URL` | No | API base override for development |

Prefer `SUWAPPU_API_KEY` over putting credentials into the JSON config.

## Installation note

This example repository is not currently published as an npm package. Clone it and run it with Bun as shown above.

## Develop

```bash
bun run typecheck
bun test
```

CI uses Bun 1.3.14, a frozen lockfile, blocking typecheck, and regression tests.

## Build further

- [Suwappu docs](https://docs.suwappu.bot)
- [SDK source](https://github.com/0xSoftBoi/suwappubot/tree/main/packages/sdk)
- [Agent/MCP docs](https://github.com/0xSoftBoi/suwappubot/blob/main/docs/agent-clients.md)

## License

[MIT](LICENSE)
