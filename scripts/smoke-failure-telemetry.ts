#!/usr/bin/env bun
/**
 * Real e2e failure sample: boot the backend, run a workflow whose agent node
 * uses a model that does not exist, and dump the ops telemetry the failed
 * Agent Run produces. Validates the failureCause/spinning telemetry path.
 *
 * Run: bun run scripts/smoke-failure-telemetry.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "smoke-token";
const dataDir = mkdtempSync(join(tmpdir(), "smoke-failure-"));
process.env.BACKEND_DATA_DIR = dataDir;
process.env.ANTHROPIC_API_KEY = "sk-fake";
process.env.BACKEND_AUTH_TOKEN = TOKEN;
process.env.OMA_FAKE_PROVIDER = "1";
process.env.OMA_FAKE_TEXT = '{"reply":"unused"}';

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

const WORKFLOW_DEF = {
  version: 1,
  id: "fail-workflow",
  meta: { name: "Fail", status: "active" },
  input: {},
  nodes: [
    { id: "start", type: "start" },
    {
      id: "agent",
      type: "agent",
      model: "fake/nope",
      prompt: 'Reply with exactly this JSON object and nothing else: {"reply":"ok"}',
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
    { from: "agent", to: "end" },
  ],
};

async function main(): Promise<void> {
  let ctx: BootCtx | undefined;
  try {
    ctx = await boot();
    const wfDir = join(dataDir, "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "fail-workflow.workflow.json"), JSON.stringify(WORKFLOW_DEF));

    const started = await post(ctx, "/api/workflow-executions", {
      workflowRef: { repo: "local", path: "fail-workflow.workflow.json" },
      input: {},
    });
    if (started.status !== 201) {
      throw new Error(`execute -> ${started.status}: ${await started.text()}`);
    }
    const { executionId } = (await started.json()) as { executionId: string };

    const deadline = Date.now() + 90_000;
    let terminal = false;
    while (Date.now() < deadline) {
      const resp = await get(ctx, `/api/workflow-executions/${executionId}/trace`);
      if (resp.ok) {
        const trace = (await resp.json()) as {
          execution?: { status?: string };
          nodeRuns?: Array<{ nodeId: string; status: string; runId?: string | null }>;
        };
        const status = trace.execution?.status ?? "unknown";
        if (["success", "failure", "custom"].includes(status)) {
          terminal = true;
          const agentNode = trace.nodeRuns?.find((n) => n.nodeId === "agent");
          console.log(
            `FAILURE E2E execution=${executionId} status=${status} agentNode=${JSON.stringify(agentNode)}`,
          );
          break;
        }
      }
      await Bun.sleep(500);
    }
    if (!terminal) throw new Error("failure workflow did not terminalize");

    const telemetryResp = await get(ctx, "/api/telemetry/summary");
    if (telemetryResp.ok) {
      const summary = (await telemetryResp.json()) as {
        failureCauses?: Array<{ cause: string; count: number }>;
        spinningRuns?: Array<unknown>;
      };
      console.log("FAILURE CAUSES", JSON.stringify(summary.failureCauses));
      console.log("SPINNING RUNS", JSON.stringify(summary.spinningRuns));
    } else {
      console.log(`FAILURE TELEMETRY error=${telemetryResp.status}`);
    }
  } finally {
    if (ctx) await shutdown(ctx);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
