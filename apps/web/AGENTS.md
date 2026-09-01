# AGENTS.md — apps/web

This file is the working contract for the Next.js web console. It is not
the root `AGENTS.md`: that describes the whole monorepo. Read both, but
trust this file for web-specific decisions.

## What this app is

A pure frontend surface for the `my-agent-team` backend. It owns no
business state; all data comes from the backend through the app's own BFF
proxy.

- Next.js 15 App Router, React 19
- Tailwind CSS 4 + shadcn/ui + `@base-ui/react`
- TanStack React Query v5
- Sonner (toast), next-themes, lucide-react
- TypeScript strict, ESM, `NodeNext`

## Commands

Run from `apps/web`:

```bash
bun run dev          # next dev on 127.0.0.1:3001
bun run build        # next build
bun run start        # next start
bun run typecheck    # tsc --noEmit
bun run lint         # biome check . && eslint .
bun run test         # bun test
bun run lint:ui      # UI consistency audit (zero CJK in src, alert/confirm ban)
```

## Data flow

- Browser never talks to the backend directly. Every request goes through
  the BFF proxy at `/api/bff/...` (`src/app/api/bff/[...path]/route.ts`).
- The typed client lives in `src/lib/api.ts`. It uses Eden Treaty and
  wraps responses via `unwrap()`.
- SSE streams use the same BFF path and are consumed by
  `src/hooks/useConversation.ts`.

### Fetch boundary rules

1. **First render doesn't need SEO / server-side backend read** → use a
   client component + React Query (`features/*/queries.ts` + `hooks.ts`).
2. **Needs direct server-side backend read** → Server Component +
   `createServerClient` (see `app/(main)/workflows/page.tsx`).
3. **Mutations are always client-side.** Server components only read.

## Feature directory pattern

Every domain gets `features/<name>/` with three files:

```
features/<name>/query-keys.ts   # stable query keys
features/<name>/queries.ts      # queryOptions / queryFn
features/<name>/hooks.ts        # useXxxQuery + useXxxMutation
```

No page-level `useQuery` with an inline query object. If a page needs a
small derived read, add a hook to the owning feature (e.g.
`useConversationTitle` in `features/conversations/hooks.ts`). The
`audit:contracts` check treats inline queryFn as a violation.

## UI conventions

- Use `@/components/ui/button` `Button`, never a raw `<button>`, for form
  and action buttons. Exemptions: canvas/toolbar overlay controls and
  segmented/tab controls where a native element is semantically right.
- Destructive actions use `useConfirm()` (`@/components/ui/confirm-dialog`)
  and `Button variant="destructive"`. Never `window.confirm`/`alert`.
- Keep all user-facing text in English in `src/`. Zero CJK in `src/` is a
  gating lint (`audit:ui`). Translation seam is `src/lib/i18n.ts`; the
  dictionary may live under `lib/locales/`.
- Prefer existing shadcn components (`Dialog`, `AlertDialog`, `Select`,
  `Input`, `Textarea`, `Badge`, `Tooltip`, etc.) over hand-rolled markup.
- Workflow editor module (`components/workflow`) already uses `Button`;
  new buttons there must too.

## Routing / navigation

- Routes are under `app/(main)/`.
- Historical renames are final:
  - `/work` → `/today`
  - `/agentic-workflow` → `/workflows`
  - `/team` → `/team/agents`
- Do not create new top-level `/work` or `/agentic-workflow` pages. If a
  link points at an old route, it must go through the redirect in
  `next.config` or be updated to the new path.
- Login deep links: middleware appends `?next=<pathname+search>` to
  `/login`; the login form must honor `next` (and sanitize it to a
  relative path).

## Known pitfalls (do not repeat)

- **Backend type staleness:** `apps/web` imports
  `@my-agent-team/backend/app` and sees the backend package's **built
  dist** types. After changing backend route/handler return types, run:
  `backend typecheck → backend build → web typecheck`. Otherwise web
  sees stale Eden-inferred types.
- **Production `next start` crash:** a `SyntaxError: Unexpected end of
  JSON input` on `next start` with no stack is usually a corrupt `.next`
  build (e.g. 0-byte `prerender-manifest.json`). `rm -rf .next` and
  rebuild; do not debug on top of a corrupted build.
- **BFF `BACKEND_URL`:** when running `next start`, `BACKEND_URL` must
  point at the backend, not at `http://127.0.0.1:3000` (or the web app
  itself). The `.env` may need an explicit override.
- **Controlled inputs in tests:** for React controlled components use the
  native prototype value setter + `dispatchEvent(new Event("input", {bubbles:true}))`;
  this is more reliable than synthesizing React events.
- **Artifacts:** the list/upload/delete path is React Query-backed in
  `features/artifacts/`. Do not add a new `useState`+`refresh()` pattern;
  use `useArtifacts()` / `useUploadArtifact()` / `useDeleteArtifact()`.
- **Workflow queue/human forms:** queue editor is
  `components/ComposerInputQueue.tsx`; approval card is
  `components/TimelineApprovalCard.tsx`. Keep these extracted; do not
  re-merge them into `Composer.tsx` / `Timeline.tsx`.
- **Run submission:** workflow Run/Submit buttons must be disabled while
  a run is in flight (`disabled={running}`) to prevent double execution.

## Review checklist before claiming done

1. `bun run typecheck` passes.
2. `bun run lint` passes (biome + eslint).
3. `bun run test` passes.
4. If UI text changed, `bun run lint:ui` passes (no CJK, no native
   alert/confirm).
5. If backend types changed, `apps/backend` was rebuilt before checking
   web.
