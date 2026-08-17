#!/usr/bin/env bun
/**
 * Phase 6 deployment smoke: full Backend HTTP stack with a REAL oma
 * child (fake provider — no network) per Product Run.
 *
 *   bun scripts/smoke-agent-run.ts --mode clean
 *   bun scripts/smoke-agent-run.ts --mode restart
 *
 * clean:   fresh data dir → auth POST message → run completes → canonical
 *          final Message lands in the ledger.
 * restart: same, then a full in-process rebuild (dispose + reopen the SAME
 *          data dir) → second round still works and both rounds' messages
 *          survive the restart.
 *
 * Pre-0020 database migration is covered by apps/backend/src/infra/sqlite/
 * db.test.ts (fixture upgrade); this script exercises process
 * reconstruction. commit_failed terminal-commit recovery is covered by
 * execution.test.ts (fault-injected commit hook).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "smoke-token";

// ─── Env must be set BEFORE backend modules load (lark registry parses
//     env at import time). ───────────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "smoke-agent-run-"));
process.env.BACKEND_DATA_DIR = dataDir;
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.BACKEND_AUTH_TOKEN = TOKEN;
process.env.OMA_FAKE_PROVIDER = "1";
process.env.OMA_FAKE_TOOLS_RECORD = `${dataDir}/tools-record.json`;

const { createApp } = await import("../apps/backend/src/app.js");
const { installFeatures } = await import("../apps/backend/src/bootstrap/features.js");
const { createBackendServices } = await import("../apps/backend/src/bootstrap/services.js");
const { loadConfig } = await import("../apps/backend/src/config.js");
const AGENT_MEMBER = { memberId: "ag1", kind: "agent", agentId: "loop-agent", displayName: "Loop" };
const HUMAN_MEMBER = { memberId: "owner", kind: "human" };

interface BootCtx {
  app: ReturnType<typeof createApp>;
  services: ReturnType<typeof createBackendServices>;
  installed: Awaited<ReturnType<typeof installFeatures>>;
}

async function boot(): Promise<BootCtx> {
  // No port listening: every request goes through app.handle().
  const config = loadConfig();
  const services = createBackendServices(config);
  const installed = await installFeatures(services);
  // Point the bootstrap agents at the fake provider's catalog entry so
  // model_preflight passes without network credentials.
  services.db
    .query(
      "UPDATE agents SET model_provider = 'fake', model_name = 'echo' WHERE id IN ('loop-agent', 'default')",
    )
    .run();
  const app = createApp(TOKEN, installed.featureSet);
  return { app, services, installed };
}

async function shutdown(ctx: BootCtx): Promise<void> {
  await ctx.installed.dispose();
  await ctx.services.mcpClientManager.disconnectAll();
  ctx.services.db.close();
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function post(ctx: BootCtx, path: string, body: unknown): Promise<Response> {
  return ctx.app.handle(
    new Request(`http://smoke${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(TOKEN) },
      body: JSON.stringify(body),
    }),
  );
}

async function get(ctx: BootCtx, path: string): Promise<Response> {
  return ctx.app.handle(new Request(`http://smoke${path}`, { headers: auth(TOKEN) }));
}

/** Consume an SSE response until the needle appears or the timeout hits.
 *  (events.text() would hang: the stream stays open.) */
async function readSseUntil(resp: Response, needle: string, timeoutMs = 8_000): Promise<boolean> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > timeoutMs) {
      await reader.cancel().catch(() => {});
      return buf.includes(needle);
    }
    const { done, value } = await reader.read();
    if (done) return buf.includes(needle);
    buf += decoder.decode(value, { stream: true });
    if (buf.includes(needle)) {
      await reader.cancel().catch(() => {});
      return true;
    }
  }
}

/** Create a conversation, post one message, wait for the run to reach a
 *  terminal state, and verify the canonical assistant Message in the ledger. */
async function runConversationRound(
  ctx: BootCtx,
  tag: string,
  timeoutMs = 30_000,
): Promise<{ conversationId: string; runId: string; status: string }> {
  const created = await post(ctx, "/api/conversations", {
    triggerMode: "mention",
    members: [HUMAN_MEMBER, AGENT_MEMBER],
  });
  if (created.status !== 201) {
    throw new Error(`[${tag}] create conversation -> ${created.status}: ${await created.text()}`);
  }
  const { conversationId } = (await created.json()) as { conversationId: string };

  const sent = await post(ctx, `/api/conversations/${conversationId}/messages`, {
    senderMemberId: "owner",
    text: `smoke ${tag}`,
    addressedTo: [AGENT_MEMBER.memberId],
  });
  if (sent.status !== 202) {
    throw new Error(`[${tag}] post message -> ${sent.status}: ${await sent.text()}`);
  }
  const { triggeredRuns } = (await sent.json()) as {
    triggeredRuns: Array<{ runId: string; queued: boolean }>;
  };
  const run = triggeredRuns?.find((r) => !r.queued);
  if (!run?.runId) {
    throw new Error(`[${tag}] no run triggered: ${JSON.stringify(triggeredRuns)}`);
  }

  // Poll the run list until terminal.
  const t0 = Date.now();
  let status = "unknown";
  for (;;) {
    const resp = await get(ctx, "/api/agent-runs");
    const body = (await resp.json()) as { runs: Array<{ runId: string; status: string }> };
    const row = body.runs?.find((r) => r.runId === run.runId);
    if (
      row &&
      ["completed", "failed", "aborted", "timeout", "commit_failed"].includes(row.status)
    ) {
      status = row.status;
      break;
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `[${tag}] run ${run.runId} not terminal after ${timeoutMs}ms (last: ${row?.status})`,
      );
    }
    await Bun.sleep(200);
  }

  // Verify the canonical final Message landed in the ledger (streamed: the
  // events endpoint stays open, so consume until it appears or timeout).
  const events = await get(ctx, `/api/conversations/${conversationId}/events?afterSeq=0`);
  if (!events.ok) throw new Error(`[${tag}] events -> ${events.status}`);
  const targetId = `run:${run.runId}:assistant:0`;
  const hasFinal = await readSseUntil(events, targetId);
  if (!hasFinal) {
    throw new Error(
      `[${tag}] final Message ${targetId} missing from ledger (run status ${status})`,
    );
  }
  return { conversationId, runId: run.runId, status };
}

async function main(): Promise<void> {
  const mode =
    process.argv[2] === "--mode" ? (process.argv[3] ?? "clean") : (process.argv[2] ?? "clean");
  if (mode !== "clean" && mode !== "restart") {
    console.error(`usage: bun scripts/smoke-agent-run.ts --mode clean|restart`);
    process.exit(2);
  }
  try {
    if (mode === "clean") {
      const ctx = await boot();
      const round = await runConversationRound(ctx, "clean");
      await shutdown(ctx);
      if (round.status !== "completed") {
        throw new Error(`clean round ended ${round.status}, expected completed`);
      }
      // The provider must have seen the advertised tool schemas (this was
      // the bug: tools registered in the loop but never sent to the model).
      const { readFileSync, existsSync } = await import("node:fs");
      const toolsRecord = `${dataDir}/tools-record.json`;
      if (!existsSync(toolsRecord)) {
        throw new Error("tools-record.json missing: model request carried no tools?");
      }
      const seen = JSON.parse(readFileSync(toolsRecord, "utf-8")) as string[];
      for (const expected of ["ls", "read", "todo_write"]) {
        if (!seen.includes(expected)) {
          throw new Error(`tool ${expected} not advertised to the model (saw: ${seen.join(",")})`);
        }
      }
      console.log(
        `SMOKE PASS [clean] run=${round.runId} status=${round.status} tools=${seen.length}`,
      );
      return;
    }

    // restart: full in-process rebuild on the same data dir.
    const first = await boot();
    const round1 = await runConversationRound(first, "restart-first");
    await shutdown(first);

    const second = await boot();
    // Round 1 conversation survived the rebuild.
    const list = await get(second, "/api/conversations");
    const convs = (await list.json()) as Array<{ conversationId: string }>;
    if (!convs.some((c) => c.conversationId === round1.conversationId)) {
      throw new Error("restart: conversation lost across rebuild");
    }
    const round2 = await runConversationRound(second, "restart-second");
    await shutdown(second);
    if (round1.status !== "completed" || round2.status !== "completed") {
      throw new Error(
        `restart: rounds ended ${round1.status}/${round2.status}, expected completed/completed`,
      );
    }
    console.log(
      `SMOKE PASS [restart] runs=${round1.runId},${round2.runId} both completed, ledger survived rebuild`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
