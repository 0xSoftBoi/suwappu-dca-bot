# Security Policy

This repository is a standalone Suwappu recurring-action reference. It is preview-only by default and can submit real managed-wallet swaps only after explicit opt-in.

## Report a vulnerability

Do not open a public issue for security reports. Use GitHub Private Vulnerability Reporting when enabled for this repository, or email **security@suwappu.bot**.

Include the affected file/version, reproduction steps, and impact. Vulnerabilities in the Suwappu API, shared SDKs, contracts, custody layer, or core bot should be reported through the [core security policy](https://github.com/0xSoftBoi/suwappubot/security/policy).

## Money-moving invariants

Changes to managed DCA should preserve all of these properties:

- preview remains the default;
- live submission requires both `--execute` and `SUWAPPU_ALLOW_MANAGED_EXECUTION=1`;
- the reference accepts fixed USDC input and enforces `SUWAPPU_MAX_DCA_USDC`;
- each plan has a stable ID, deterministic schedule-slot identity, explicit timezone, and no sub-hour cadence;
- the route must include valid minimum output, useful TTL (including a post-simulation re-check), and estimated gas at/below `maxGasUsd`;
- `/swap/simulate` must explicitly return `would_execute: true`;
- a durable intent/idempotency key exists before submission becomes ambiguous;
- retries of one economic action reuse that exact key;
- network/timeout/HTTP 408/5xx or malformed-2xx ambiguity is `outcome_unknown`, never assumed failure;
- an unresolved action blocks a fresh installment for that plan until recovery/reconciliation;
- known swap IDs are reconciled without resubmission;
- final amounts remain distinct from quoted amounts;
- one local state directory has one scheduler/run/reconciliation writer through an exclusive lock;
- client controls supplement server-side wallet policies.

Add regression coverage when changing any of these invariants.

## Durable state is part of the safety boundary

The scheduler stores `execution-journal.json` under `~/.suwappu-dca` by default. Override the directory with `SUWAPPU_DCA_STATE_DIR` when you can guarantee durable storage.

Do not delete or truncate unresolved `prepared`, `submitting`, `submitted`, or `outcome_unknown` records as a retry mechanism. Losing an idempotency key can turn one scheduled economic action into two.

The CLI enforces one local writer with `execution.lock` for `start`, `run-once`, and `history --reconcile`. A stale lock is intentionally not auto-deleted: prove the recorded process is gone before clearing it. The state directory is mode `0700`; journal/lock files are mode `0600`; replacement uses a unique temporary file, file `fsync`, atomic rename, and best-effort directory `fsync`.

`SUWAPPU_DCA_JOURNAL_LIMIT` is a soft retention target. Only preview records are eligible for automatic pruning; failed, completed, and unresolved execution evidence is retained even when that means exceeding the target.

Do not point multiple hosts/replicas at this JSON directory and treat the local lock as distributed consensus. Use transactional storage, uniqueness constraints, and distributed concurrency control before horizontal scale.

## Network and telemetry boundary

- Every Suwappu operation has a bounded deadline (`SUWAPPU_OPERATION_TIMEOUT_MS`, default 25 seconds, maximum 30 seconds).
- Upstream HTTP response bodies are not copied into request errors.
- Optional `SUWAPPU_API_EVENTS` telemetry contains only operation, transport/protocol outcome, duration, and HTTP status. It excludes credentials, wallet/market terms, quote/swap IDs, bodies, and error text.
- Metadata events never prove a transaction succeeded; terminal managed outcomes come from reconciliation.

## Credentials and wallets

- The plan file does not load API credentials; keep secrets in environment/secret management.
- Never commit `.env`, API keys, private keys, or wallet credentials.
- Use a dedicated wallet and least-privileged Suwappu identity while developing.
- Put restrictive server-side wallet policies around assets and spend before managed mode.
- Rotate exposed credentials immediately.

## Coordinated disclosure

We will coordinate remediation and disclosure with the reporter and provide credit unless anonymity is requested. Do not infer a response-time SLA from this repository; organization-level security commitments should be documented and staffed separately.

If testing could touch live funds, private data, or service availability, contact us before testing against production infrastructure.
