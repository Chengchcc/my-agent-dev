# my-agent-team Overview

my-agent-team is a TypeScript/Bun monorepo for building multi-agent AI systems.
It spans a protocol-level agent runtime, a production backend, and a web UI,
plus a Loop automation engine that subsumes issue triage and cron-based work.

## Stack

- Runtime: Bun 1.3.x, TypeScript 6.x ESM with NodeNext resolution
- Monorepo: Turborepo v2
- Backend: Elysia HTTP, Drizzle ORM + SQLite
- Frontend: Next.js 15 App Router, React Query v5, shadcn/ui + Tailwind CSS v4
- Lint/format: Biome + ESLint

## Layer map

- L5 Surfaces: web UI and IM bots talk HTTP/SSE to the backend
- L4 Backend: multi-agent service (Elysia HTTP, auth, tenancy, runner pool)
- L3 Agent: createAgentSession composes model + tools + plugins + persistence + context pipeline
- L2 Runtime: run() async generator loops messages -> model stream -> tool execute
- L1 Protocols: Message / ChatModel / Tool / ContentBlock contracts

## Top-level directories

- apps/backend: Elysia server, services, routes, cron, Loop orchestration
- apps/web: Next.js App Router UI
- apps/coding-agent: Pi-like CLI child process (run-centric RPC)
- apps/lark-bot: Lark/Feishu IM integration
- packages/core: protocol types + run/collectStream
- packages/agent: agent lifecycle, createAgentSession, plugins, context pipeline
- packages/agent-backend: run-centric backend contracts
- packages/loop: pure Loop state machine
- packages/ai: provider/model registry
- packages/tools-common: read/write/edit/bash/grep/glob/web tools
- packages/adapter-*: per-backend child-process adapters
- skills/: skill packs (SKILL.md + registry.yaml)
- knowledge-packs/: builtin knowledge packs
- docs/: architecture docs, ADRs, superpowers
