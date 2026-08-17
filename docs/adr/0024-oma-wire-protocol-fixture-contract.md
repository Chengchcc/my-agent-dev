# ADR 0024: Oma wire protocol is child-owned and fixture-tested

**Date:** 2026-08-17
**Status:** accepted

## Context

`agent-backend` currently holds two kinds of content:

1. Backend-agnostic contracts: `AgentBackend`, `BackendRunInput/Outcome/Segment`,
   `BackendEvent`, `BackendKind`, `BackendModelRef`, `PendingAction`, and the
   shared redaction helpers.
2. Oma-specific stdio JSONL wire protocol: command/output/event/outcome schemas
   plus `mapRunEvent` / `mapRunOutcome`.

This makes both `apps/oh-my-agent` (child) and `packages/adapter-oma-agent`
depend on the same wire schema package. The child's wire format is an internal
implementation detail, not a cross-backend contract, so coupling it through the
neutral contract package is the wrong boundary.

## Decision

- `agent-backend` keeps only the backend-agnostic contracts. The oma wire
  schemas and mapping are removed from it.
- `apps/oh-my-agent` owns its JSONL wire format internally. It does not depend
  on a shared wire-schema package.
- `packages/adapter-oma-agent` implements `AgentBackend` and contains its own
  parser/types for the oma JSONL format.
- The two sides do NOT share a wire protocol package. Instead the contract is a
  fixture:
  - `apps/oh-my-agent` generates canonical `rpc-*.jsonl` fixtures with the real
    child and the fake provider.
  - `packages/adapter-oma-agent` tests consume those fixtures and drive
    `OmaBackend` against them.
- Protocol change workflow: change child -> regenerate fixture -> adapter tests
  go red -> update adapter parser.

## Consequences

- Drift protection is test-based, not compile-time. The fixture is the contract.
- Wire types are duplicated on the adapter side. This is accepted because the
  fixture test pins the shape.
- `agent-backend` becomes strictly backend-agnostic; Product Backend remains
  independent of any specific child wire protocol.
- `docs/architecture/e2e-contract-rules.md` is updated to reflect the new rule.
