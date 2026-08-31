# my-agent-team Overview

my-agent-team is a TypeScript/Bun monorepo for building multi-agent AI systems.
It spans a protocol-level agent runtime, a production backend, and a web UI,
plus an agentic Workflow engine (node-graph DSL: agent / script / human nodes,
cron triggers, artifacts).

## Stack

- Runtime: Bun 1.3.x, TypeScript 6.x ESM with NodeNext resolution
- Monorepo: Turborepo v2
- Backend: Elysia HTTP, Drizzle ORM + SQLite
- Frontend: Next.js 15 App Router, React Query v5, shadcn/ui + Tailwind CSS v4
- Lint/format: Biome + ESLint

## Layer map

- L5 Surfaces: web UI and IM bots talk HTTP/SSE to the backend
- L4 Backend: multi-agent service (Elysia HTTP, auth, tenancy, runner pool)
- L3 Adapter: packages/adapter-* — child process boundary (spawn / JSONL RPC / steer / abort / approval)
- L2 Runtime: apps/oh-my-agent/src/core — createOmaSession(): model/tool loop, plugins, compaction
- L1 Protocols: Message / ChatModel / Tool / ContentBlock contracts

## Top-level directories

- apps/backend: Elysia server, services, routes, cron, Loop orchestration
- apps/web: Next.js App Router UI
- apps/oh-my-agent: Pi-like CLI child process (run-centric RPC)
- apps/lark-bot: Lark/Feishu IM integration
- packages/message: protocol types, ChatModel/Tool contracts, stream utils
- packages/agent-contract: spawn-neutral AgentBackend contracts (4 adapters implement)
- packages/workflow: Workflow DSL pure domain (node graph, JSON-Logic, computeNext engine)
- packages/sandbox: process sandbox for workflow script nodes + oma eval tool
- packages/ai: provider/model registry (multi-API, ADR 0018)
- packages/source-fetch: git/zip source materialization base
- packages/tui: terminal UI toolkit backing the oma TUI
- packages/adapter-*: per-backend child-process adapters (oma / claude / pi / omp / mcp client)
- skills/: skill packs (SKILL.md + registry.yaml)
- knowledge-packs/: builtin knowledge packs
- docs/: architecture docs, ADRs, superpowers
