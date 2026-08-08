# Changelog

## 2.0.0

### Safety and operations

- Enforce one local journal writer for scheduling, one-off actions, and reconciliation with an ownership-token lock.
- Harden state durability with owner-only permissions, unique temporary files, `fsync`, atomic replacement, and soft retention that never prunes completed/unresolved execution evidence.
- Bound Suwappu operations with configurable deadlines and add metadata-only API outcome events.
- Treat HTTP 408/5xx, transport failures, and malformed successful managed-execute responses as outcome-unknown; sanitize upstream HTTP bodies from request errors.
- Strictly bind quote token pairs, simulation quote IDs, top-level success, and status swap IDs to the requested operation.
- Upgrade to node-cron 4.6, bind action identity to the scheduler's intended instant, and enable per-task overlap protection.

### Standalone product contract

- Make plan validation and plain history local/credential-free; require an API key only for commands that actually need Suwappu network access.
- Add a non-root container with a zero-network validation default, Compose contract, operations runbook, build/audit/container CI gates, and CodeQL.
- Pin the dependency graph represented by `bun.lock` and add a single `bun run verify` release gate.
- Expand builder economics and enterprise-graduation guidance without implying investment returns.

## 1.1.0

- Added fixed-USDC plan caps, explicit timezones, DST-safe wall-clock slot identity, quote gas/TTL guards, durable intent/idempotency state, outcome-unknown recovery, and terminal reconciliation.
