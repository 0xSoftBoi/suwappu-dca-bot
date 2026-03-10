# suwappu-dca-bot

**Dollar Cost Averaging bot for the [Suwappu](https://suwappu.bot) cross-chain DEX.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org)
[![Suwappu SDK](https://img.shields.io/badge/Suwappu_SDK-0.5.0-purple.svg)](https://www.npmjs.com/package/@suwappu/sdk)

Configure recurring token purchases with cron scheduling. "Buy $50 of ETH on Base every morning" — the bot handles quoting and execution automatically across any of 15 supported chains.

---

## Features

- **Cron scheduling** — Standard cron expressions for precise timing
- **Multi-plan** — Run multiple DCA plans simultaneously
- **Any token, any chain** — Works across 15 networks including Ethereum, Solana, Base, Arbitrum
- **Execution history** — Persistent log of all past buys with transaction hashes
- **One-time buy** — Execute a single purchase immediately via CLI
- **OpenClaw compatible** — Includes SKILL.md for AI agent discovery

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/0xSoftBoi/suwappu-dca-bot.git
cd suwappu-dca-bot

# 2. Install
bun install

# 3. Get a free API key
curl -X POST https://api.suwappu.bot/v1/agent/register \
  -H "Content-Type: application/json" \
  -d '{"name": "my-dca-bot"}'

# 4. Set your key
export SUWAPPU_API_KEY=suwappu_sk_...

# 5. Copy example config
mkdir -p ~/.suwappu-dca
cp examples/dca-config.example.json ~/.suwappu-dca/config.json

# 6. Start the bot
bun src/index.ts start

# Or: one-time buy
bun src/index.ts run-once --from USDC --to ETH --amount 50 --chain base
```

---

## Configuration

Place your config at `~/.suwappu-dca/config.json`:

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
      "schedule": "0 9 * * *"
    },
    {
      "id": "weekly-sol",
      "name": "Weekly SOL",
      "fromToken": "USDC",
      "toToken": "SOL",
      "amount": 100,
      "chain": "solana",
      "schedule": "0 9 * * 1"
    }
  ]
}
```

### Plan Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique plan identifier |
| `name` | `string` | Human-readable name |
| `fromToken` | `string` | Token to sell (e.g. `"USDC"`) |
| `toToken` | `string` | Token to buy (e.g. `"ETH"`) |
| `amount` | `number` | USD amount per buy |
| `chain` | `string` | Chain to execute on |
| `schedule` | `string` | Cron expression |
| `enabled` | `boolean` | Optional. Default: `true` |

### Cron Schedule Reference

| Pattern | Description |
|---------|-------------|
| `0 9 * * *` | Every day at 9:00 AM |
| `0 9 * * 1` | Every Monday at 9:00 AM |
| `0 */4 * * *` | Every 4 hours |
| `0 9 1 * *` | First of every month |
| `0 9,21 * * *` | Twice daily at 9 AM and 9 PM |

---

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start the DCA scheduler (runs continuously) |
| `status` | Show all configured plans |
| `history` | Show past execution log |
| `run-once` | Execute a single buy immediately |

### Run-Once Options

```bash
bun src/index.ts run-once \
  --from USDC \
  --to ETH \
  --amount 50 \
  --chain base
```

---

## How It Works

1. **Configure** — Define plans with token pairs, amounts, and cron schedules
2. **Schedule** — Bot registers cron jobs for each enabled plan
3. **Execute** — At each trigger, gets a quote from Suwappu and executes the swap
4. **Log** — Records every execution to `~/.suwappu-dca/history.json`

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUWAPPU_API_KEY` | Yes | Your Suwappu API key |

---

## License

[MIT](LICENSE)
