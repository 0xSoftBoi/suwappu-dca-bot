---
name: suwappu-dca
description: Dollar Cost Averaging bot — schedule recurring token buys on any of 15 chains with cron scheduling
user-invocable: true
tools:
  - start_dca
  - dca_status
  - dca_history
  - run_once
metadata:
  openclaw.requires.env: ["SUWAPPU_API_KEY"]
  openclaw.primaryEnv: SUWAPPU_API_KEY
  openclaw.emoji: "📅"
  openclaw.category: defi
  openclaw.tags: ["dca", "trading", "scheduling", "defi", "cross-chain"]
  openclaw.install:
    - type: npm
      package: "suwappu-dca-bot"
---

# Suwappu DCA Bot

Schedule recurring token purchases with cron-based timing. "Buy $50 of ETH on Base every day" — the bot handles quotes and execution automatically.

## Setup

```bash
export SUWAPPU_API_KEY=suwappu_sk_...
```

## Tools

### start_dca
Start the DCA scheduler with configured plans. Runs continuously, executing buys on schedule.

### dca_status
Show all active DCA plans with their schedules and next execution time.

### dca_history
Display past DCA executions with amounts, transaction hashes, and success/failure.

### run_once
Execute a single DCA buy immediately: `run_once --from USDC --to ETH --amount 50 --chain base`

## Configuration

```json
{
  "plans": [
    { "name": "Daily ETH", "fromToken": "USDC", "toToken": "ETH", "amount": 50, "chain": "base", "schedule": "0 9 * * *" }
  ]
}
```
