---
name: suwappu-dca
description: Preview-first Suwappu DCA scheduler for recurring token purchases across 14 supported chains
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
---

# Suwappu DCA Bot

Use this skill to configure, preview, and inspect recurring Suwappu purchase plans.

The safe default is read/quote-only preview. Do not infer permission to submit managed swaps from a request to configure, inspect, start, or preview a DCA plan.

## Setup

Clone the repository and install it locally:

```bash
bun install --frozen-lockfile
export SUWAPPU_API_KEY=suwappu_sk_...
```

This example is not currently published as an npm package.

## Tools

### start_dca

Start configured schedules. Default behavior is preview-only at every trigger.

Only use managed execution when the user explicitly asks to execute, `--execute` is present, `SUWAPPU_ALLOW_MANAGED_EXECUTION=1`, and `SUWAPPU_WALLET_ADDRESS` identifies the intended wallet.

### dca_status

Show configured source-token amounts, pairs, chains, cron expressions, timezones, and enabled state. This does not execute.

### dca_history

Show distinct `preview`, `submitted`, and `failed` outcomes plus quote/swap identifiers when available.

### run_once

Preview a single purchase by default. `amount` is source-token units, not automatically USD.

## Execution boundary

For managed execution the implementation must follow:

```text
wallet-bound quote
  → simulation success === true
  → managed /swap/execute submission
```

A configured API key, wallet, schedule, or environment opt-in alone is not sufficient authorization. The command still requires `--execute`.

For self-custody workflows, use Suwappu's unsigned transaction preparation flow instead of this scheduler's managed endpoint.

## Scheduling

Prefer an explicit IANA `timezone` such as `America/New_York` or `UTC`. Plans with the same id are rejected, and an overlapping run of a plan is skipped.

Use Suwappu wallet policies for durable value/asset limits; client-side cron and amount checks are not a substitute for server-side policy.

Builder docs: https://docs.suwappu.bot
