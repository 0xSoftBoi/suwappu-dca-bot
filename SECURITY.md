# Security Policy

This repository is a Suwappu recurring-action reference. It is preview-only by default and can submit real managed-wallet swaps only after explicit opt-in.

## Report a vulnerability

Do not open a public issue for security reports. Use GitHub Private Vulnerability Reporting when enabled for this repository, or email **security@suwappu.bot**.

Include the affected file/version, reproduction steps, and impact. Vulnerabilities in the Suwappu API, shared SDKs, contracts, custody layer, or core bot should be reported through the [core security policy](https://github.com/0xSoftBoi/suwappubot/security/policy).

## Money-moving invariants

Changes to managed DCA should preserve all of these properties:

- preview remains the default;
- live submission requires both `--execute` and `SUWAPPU_ALLOW_MANAGED_EXECUTION=1`;
- the reference accepts fixed USDC input and enforces `SUWAPPU_MAX_DCA_USDC`;
- each plan has a stable ID, deterministic schedule-slot identity, explicit timezone, and no sub-hour cadence;
- the route must include valid minimum output, useful TTL, and estimated gas at/below `maxGasUsd`;
- `/swap/simulate` must explicitly return `would_execute: true`;
- a durable intent/idempotency key exists before submission becomes ambiguous;
- retries of one economic action reuse that exact key;
- network/timeout/5xx ambiguity is `outcome_unknown`, never assumed failure;
- an unresolved action blocks a fresh installment for that plan until recovery/reconciliation;
- known swap IDs are reconciled without resubmission;
- final amounts remain distinct from quoted amounts;
- client controls supplement server-side wallet policies.

Add regression coverage when changing any of these invariants.

## Durable state is part of the safety boundary

The scheduler stores `execution-journal.json` under `~/.suwappu-dca` by default. Override the directory with `SUWAPPU_DCA_STATE_DIR` when you can guarantee durable storage.

Do not delete or truncate unresolved `prepared`, `submitting`, `submitted`, or `outcome_unknown` records as a retry mechanism. Losing an idempotency key can turn one scheduled economic action into two.

The JSON journal has atomic writes but is intentionally single-writer. Do not run multiple scheduler replicas against the same local state directory. Use transactional storage, uniqueness constraints, and concurrency control before horizontal scale.

## Credentials and wallets

- The plan file does not load API credentials; keep secrets in environment/secret management.
- Never commit `.env`, API keys, private keys, or wallet credentials.
- Use a dedicated wallet and least-privileged Suwappu identity while developing.
- Put restrictive server-side wallet policies around assets and spend before managed mode.
- Rotate exposed credentials immediately.

## Coordinated disclosure

We aim to acknowledge reports within 3 business days, triage severity within 7 business days, coordinate disclosure with the reporter, and provide credit unless anonymity is requested.

Good-faith research conducted without privacy violations, data destruction, or service degradation is covered by our safe-harbor intent. If in doubt, contact us before testing live infrastructure.
