# Contributing

Thanks for improving the Suwappu DCA reference. Changes should make recurring economic intent easier to understand, safer to operate, or easier to turn into a real product.

## Local checks

Use Bun 1.3.14 or newer and the committed lockfile:

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs TypeScript checking, tests, a standalone build, and a high-severity dependency audit. CI additionally builds the non-root container and runs CodeQL.

## Money-path changes

Treat edits to execution state, schedule/action identity, simulation/execute/status handling, live-mode gates, retry/idempotency semantics, or state migrations as money-path changes.

Preserve these invariants:

- preview is the default;
- managed execution requires two explicit gates;
- one plan/local wall-clock slot maps to at most one economic action;
- intent/idempotency exists before submission risk;
- ambiguous submission stays `outcome_unknown` and reuses the same key;
- known swap IDs are status-only;
- one local journal has one writer;
- unresolved state is never deleted to satisfy retention;
- customer strategy performance is never presented as builder revenue/margin.

Add a regression test for the failure mode a money-path change could introduce. For operational semantics, update `docs/OPERATIONS.md` and the README in the same pull request.

## Scope

Keep this repository a small standalone Suwappu recurring-action reference. Strategy research, multi-order orchestration, portfolio risk, and distributed multi-tenant scheduling belong in purpose-built layers; document the graduation point rather than growing hidden framework behavior here.
