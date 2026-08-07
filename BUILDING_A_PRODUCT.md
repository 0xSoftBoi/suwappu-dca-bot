# Turn DCA Automation into a Product

A cron file is not a business. The product opportunity is reliable recurring intent: help a user define a budget, understand each planned action, keep execution inside explicit limits, and prove what happened afterward.

This guide is about product and operating economics. It does not claim that dollar-cost averaging will produce investment profit.

## What a customer can actually value

Start with one repeated job:

- “Invest this fixed budget on the cadence I chose without babysitting a wallet.”
- “Tell me when a planned buy was skipped because execution costs or policy made it unattractive.”
- “Give our team an approval/audit workflow for recurring treasury purchases.”
- “Let our agent schedule bounded recurring actions without inventing retry semantics.”

Those are workflow outcomes. They can be measured even when the purchased asset falls in value.

## Product ladder

| Stage | Customer value | Capital moves? | What you add |
|---|---|---:|---|
| Plan + preview | Cadence/budget visibility and executable route previews | No | plan UI, calendar, cost estimates, history |
| Approval workflow | “Ready to buy” notification with route/policy context | Only after approval | notifications, roles, approvals, audit trail |
| Bounded automation | Reliable recurring execution inside explicit limits | Yes | durable intents, policies, reconciliation, alerts |
| Treasury/team product | Shared recurring policy with accountability | Yes | tenant isolation, RBAC, budgets, exports, compliance workflow |

Validate retention at the first two stages before taking on unattended-capital operations.

## Activation and retention

A useful funnel is:

1. user creates a valid plan with amount, asset, cadence, timezone, and gas ceiling;
2. first scheduled slot produces a route-qualified preview;
3. user understands why an action was previewed, blocked, failed, or completed;
4. opted-in users reach a terminal reconciled action;
5. users keep plans intentionally enabled because the workflow saves effort or improves control.

Track product metrics such as:

- plans created -> first successful preview;
- scheduled slots by `preview` / `completed` / `failed` / `outcome_unknown`;
- gas-ceiling and simulation-block rates;
- approval conversion if your product has approval mode;
- median time to terminal reconciliation;
- retained enabled plans and retained active customers;
- spend-policy/cap rejections (a control signal, not merely an error);
- support/operator interventions per 100 scheduled actions.

## Request economics are naturally bounded

Unlike a price-polling strategy, a DCA scheduler does not need to ask for a price every few seconds. Each due preview normally needs one quote. A new managed action adds simulation + execute and then status polling until terminal.

That makes per-plan API usage easier to model:

```text
preview slot ≈ 1 quote
managed slot ≈ 1 quote + 1 simulation + 1 execute + reconciliation reads
ambiguous recovery ≈ fresh same-terms quote + simulation + same-key retry
```

Use the current Suwappu pricing/rate-limit documentation for real unit costs; do not freeze copied prices into your business model.

## Separate builder economics from customer investment performance

Your product can have healthy unit economics during a month when a customer's purchased asset declines, and vice versa.

Builder contribution margin:

```text
subscription / usage revenue
- Suwappu API cost
- hosting + database + notification cost
- payment fees + support + credits/refunds
```

Customer strategy result:

```text
realized / marked value of acquired inventory
- acquisition cost
- execution and strategy costs
```

This repo implements recurring acquisition, not a complete portfolio/P&L engine. Do not turn quoted output into a fake “profit” number.

## Monetization that maps to the workflow

Examples to test:

- free tier with a small number of preview plans;
- individual subscription for recurring automation, alerts, and history;
- team tier for approvals, roles, shared budgets, and exports;
- usage tier for higher action/reconciliation volume;
- vertical treasury automation when recurring purchases are part of a larger operational workflow.

The Agent API does not imply a generic third-party `builder_fee`. Charge customers explicitly through your own product/billing contract unless a documented Suwappu attribution mechanism applies to your specific surface.

## Production work before charging for managed automation

The repository intentionally stops at a single-process local journal. Upgrade these pieces before multi-tenant scale:

### State and concurrency

- put plan/action intents in transactional durable storage;
- enforce uniqueness on tenant + plan + schedule slot;
- serialize conflicting plan actions;
- keep idempotency keys across deploys indefinitely enough to resolve every ambiguous action;
- run reconciliation as a durable background job;
- define an explicit operator workflow for stale `outcome_unknown` records.

### Budgets and permissions

- isolate each customer's API identity/state;
- apply server-side wallet policies in addition to client caps;
- expose per-action and period budgets in the UI;
- make plan enable/disable, amount changes, and live-mode promotion auditable;
- require explicit re-approval for material scope/asset/budget changes.

### Scheduling semantics

Decide and document:

- timezone and daylight-saving behavior;
- whether missed slots are skipped or eligible for catch-up;
- how long a pending/unknown action blocks future installments;
- whether an operator can intentionally abandon a pre-submission action;
- how plan edits interact with already-durable economic intent.

Never make “catch up all missed buys” the accidental result of a restart loop.

### Customer reporting

Show quoted and final amounts separately. Let a customer answer:

- which schedule slot caused this action?
- what amount/asset/chain was authorized?
- what gas ceiling/policy applied?
- did simulation permit execution?
- was submission accepted, pending, failed, or outcome-unknown?
- what were the reconciled final amounts?

The audit trail is a product feature, not just debugging data.

## Know when this repo is no longer enough

[Hummingbot's DCAExecutor](https://hummingbot.org/strategies/v2-strategies/executors/dcaexecutor/) is a useful benchmark when recurring investing becomes an order-lifecycle problem. [Freqtrade's position-adjustment docs](https://www.freqtrade.io/en/stable/strategy-callbacks/) show why DCA-like re-entry needs explicit state and limits in a full trading strategy.

Keep this repository as the small Suwappu-specific action boundary. Add a deeper framework when your product genuinely needs strategy state, multi-order execution, exits, backtesting, or portfolio risk.

## A good first paid experiment

1. Offer preview-only fixed-USDC plans and route/cost notifications.
2. Measure whether users keep plans and act on the previews.
3. Add approvals for users who want a one-click action from the same context.
4. Add bounded managed automation for users who explicitly request it.
5. Price the workflow from observed retention and operating cost, not from promised token returns.

The moat is not the cron expression. It is trusted recurring intent and a clean outcome loop.
