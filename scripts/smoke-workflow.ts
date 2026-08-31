#!/usr/bin/env bun
/**
 * I4 (docs/insights.md): real-model workflow smoke - the whole Workflow
 * execution chain with a REAL provider (fake oma provider = real child
 * process, no network):
 *
 *   POST /api/workflows/execute
 *   -> WorkflowExecution (agent node + script node + end)
 *   -> agent node dispatches a REAL Agent Run (oma child spawned over JSONL)
 *   -> script node runs in the process sandbox
 *   -> execution reaches terminal success with both node outputs
 *
 * Verifications: execution status success; agent node run completed with
 * runId; script node run completed; node-run order; the conversation the
 * agent node created (`workflow:<executionId>:<nodeId>`) has the final
 * assistant message in the ledger. Fails non-zero on any mismatch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "smoke-token";

// ─── Env must be set BEFORE backend modules load ──────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "smoke-workflow-"));
process.env.BACKEND_DATA_DIR = dataDir;
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.BACKEND_AUTH_TOKEN = TOKEN;
process.env.OMA_FAKE_PROVIDER = "1";
process.env.OMA_FAKE_TEXT = '{"reply":"smoke-ok"}';

const { createApp } = await import("../apps/backend/src/app.js");
const { installFeatures } = await import("../apps/backend/src/bootstrap/features.js");
const { createBackendServices } = await import("../apps/backend/src/bootstrap/services.js");
const { loadConfig } = await import("../apps/backend/src/config.js");

interface BootCtx {
  app: ReturnType<typeof createApp>;
  services: ReturnType<typeof createBackendServices>;
  installed: Awaited<ReturnType<typeof installFeatures>>;
}

async function boot(): Promise<BootCtx> {
  const config = loadConfig();
  const services = createBackendServices(config);
  const installed = await installFeatures(services);
  // Point the default agent at the fake provider so model preflight passes
  // without network credentials. The model lives inside the agents.config
  // JSON (runtime_config.model_id) - there are no model_provider columns.
  services.db
    .query(
      "UPDATE agents SET config = json_set(config, '$.runtime_config.model_id', 'fake/echo') WHERE id = 'default'",
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

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

async function post(ctx: BootCtx, path: string, body: unknown): Promise<Response> {
  return ctx.app.handle(
    new Request(`http://smoke${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth() },
      body: JSON.stringify(body),
    }),
  );
}

async function get(ctx: BootCtx, path: string): Promise<Response> {
  return ctx.app.handle(new Request(`http://smoke${path}`, { headers: auth() }));
}

/** The fake provider emits a deterministic JSON reply (the agent node's
 *  outputSchema demands {reply: string}) - the prompt makes the scripted
 *  echo produce parseable JSON for extractOutput. */
const WORKFLOW_DEF = {
  version: 1,
  id: "smoke-workflow",
  meta: { name: "Smoke", status: "active" },
  input: {},
  nodes: [
    { id: "start", type: "start" },
    {
      id: "agent",
      type: "agent",
      model: "fake/echo",
      prompt: 'Reply with exactly this JSON object and nothing else: {"reply":"smoke-ok"}',
      output: { reply: "string" },
      outputSchema: {
        type: "object",
        properties: { reply: { type: "string" } },
        required: ["reply"],
      },
    },
    {
      id: "script",
      type: "script",
      code: 'export default async (ctx) => ({ reply: `script:${ctx.reply ?? "?"}` });',
      output: { reply: "string" },
      outputSchema: {
        type: "object",
        properties: { reply: { type: "string" } },
        required: ["reply"],
      },
    },
    { id: "end", type: "end", status: "success" },
  ],
  edges: [
    { from: "start", to: "agent" },
    { from: "agent", to: "script" },
    { from: "script", to: "end" },
  ],
};
async function main(): Promise<void> {
  let ctx: BootCtx | undefined;
  try {
    ctx = await boot();

    // 1. Write the definition into dataDir/workflows (the executions route
    const wfDir = join(dataDir, "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "smoke-workflow.workflow.json"), JSON.stringify(WORKFLOW_DEF));

    // 2. Start the execution over HTTP (the same entry the web UI uses).
    const started = await post(ctx, "/api/workflow-executions", {
      workflowRef: { repo: "local", path: "smoke-workflow.workflow.json" },
      input: {},
    });
    if (started.status !== 201) {
      throw new Error(`execute -> ${started.status}: ${await started.text()}`);
    }
    const { executionId } = (await started.json()) as { executionId: string };

    // 3. Poll the trace until terminal (agent node polls the child run at
    //    1s; the whole chain settles in a few seconds with the fake provider).
    const deadline = Date.now() + 90_000;
    let trace:
      | {
          execution: { status?: string; exit?: string; error?: string };
          nodeRuns: Array<{
            nodeId: string;
            status: string;
            runId?: string | null;
            output?: Record<string, unknown>;
          }>;
        }
      | undefined;
    for (;;) {
      const resp = await get(ctx, `/api/workflow-executions/${executionId}/trace`);
      if (resp.ok) trace = (await resp.json()) as typeof trace;
      const status = trace?.execution.status ?? "unknown";
      if (["success", "failure", "custom"].includes(status)) break;
      if (Date.now() > deadline) {
        throw new Error(`execution not terminal after 90s (last: ${status})`);
      }
      await Bun.sleep(500);
    }
    const exec = trace?.execution;
    if (exec?.status !== "success") {
      throw new Error(
        `execution ended ${String(exec?.status)} / exit=${String(exec?.exit)} error=${String(exec?.error)}`,
      );
    }

    // 4. Node runs: agent (with a real runId) and script, both completed.
    const nodeRuns = trace?.nodeRuns ?? [];
    const byId = new Map(nodeRuns.map((n) => [n.nodeId, n]));
    const agentRun = byId.get("agent");
    const scriptRun = byId.get("script");
    if (!agentRun?.runId) throw new Error(`agent node has no runId: ${JSON.stringify(agentRun)}`);
    if (agentRun.status !== "completed") throw new Error(`agent node status ${agentRun.status}`);
    if (scriptRun?.status !== "completed")
      throw new Error(`script node status ${scriptRun?.status}`);
    if (String(scriptRun?.output?.reply) !== "script:smoke-ok")
      throw new Error(`script output unexpected: ${JSON.stringify(scriptRun?.output)}`);

    // 5. The agent node's conversation: final assistant Message in the ledger.
    const conversationId = `workflow:${executionId}:agent`;
    const events = await get(ctx, `/api/conversations/${conversationId}/events?afterSeq=0`);
    if (!events.ok) throw new Error(`conversation events -> ${events.status}`);
    const targetId = `run:${agentRun.runId}:assistant:0`;
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const t0 = Date.now();
    let hasFinal = false;
    for (;;) {
      if (buf.includes(targetId) || Date.now() - t0 > 10_000) {
        hasFinal = buf.includes(targetId);
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    if (!hasFinal) {
      throw new Error(`final Message ${targetId} missing from the workflow conversation ledger`);
    }

    console.log(
      `SMOKE PASS [workflow] execution=${executionId} agentRun=${agentRun.runId} ` +
        `nodes=agent+script completed, ledger message landed`,
    );
  } finally {
    if (ctx) await shutdown(ctx);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
