import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** Scripted Coding Agent RPC fixture for adapter/backend tests. Speaks the
 *  stdio JSONL protocol from agent-backend with env-driven failure injection.
 *  Spawned as: bun rpc-fixture.ts [--list-models --json] [--mode rpc]
 *
 *  Scenarios (RPC_FIXTURE_SCENARIO):
 *    normal             execute -> success, events, delayed outcome, exit 0
 *    reject-execute     execute -> success:false "simulated execute failure"
 *    reject-first-execute  first execute rejects, later ones accept (the
 *                       record file is the shared state across children)
 *    exit-before-acceptance  exit(3) immediately
 *    exit-before-outcome     success, then exit(5) before outcome
 *    malformed-stdout        success, then a non-JSON stdout line, exit(1)
 *    stderr-flood            success, 200 KiB stderr incl. RPC_FIXTURE_SECRET,
 *                            outcome failed, exit(1)
 *    no-events               success, then wait for abort, respond, exit(0)
 *    silent                  never respond to execute (stuck pre-acceptance;
 *                            dispose() must SIGTERM without awaiting acceptance)
 *                            WITHOUT any outcome (abort-grace path)
 *    steer-error             steer responds success:false
 *
 *  Observation hooks:
 *    RPC_FIXTURE_RECORD=<file>     append "execute|steer|abort|outcome <runId>"
 *    RPC_FIXTURE_CWD_MARKER=<file> write process.cwd() on execute
 *    RPC_FIXTURE_OUTCOME_DELAY_MS  delay before the outcome (default 60)
 */

const argv = process.argv.slice(2);
if (argv.includes("--list-models")) {
  process.stdout.write(
    `${JSON.stringify({
      backendKind: "coding_agent",
      models: [
        {
          id: "fake/echo",
          displayName: "Fake Echo",
          reasoning: false,
          inputModalities: ["text"],
          contextWindow: 200_000,
          maxOutputTokens: 8192,
          available: true,
        },
      ],
    })}\n`,
  );
  process.exit(0);
}

const scenario = process.env.RPC_FIXTURE_SCENARIO ?? "normal";
const record = process.env.RPC_FIXTURE_RECORD;
const cwdMarker = process.env.RPC_FIXTURE_CWD_MARKER;
const outcomeDelayMs = Number(process.env.RPC_FIXTURE_OUTCOME_DELAY_MS ?? 60);

function note(kind: string, runId: string): void {
  if (record) appendFileSync(record, `${kind} ${runId}\n`);
}
const out = (obj: unknown): void => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

async function main(): Promise<void> {
  if (scenario === "exit-before-acceptance") process.exit(3);

  const decoder = new TextDecoder();
  let buffer = "";
  const stdinReader = (Bun.stdin.stream() as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await stdinReader.read();
    if (done) break;
    const chunk = value;
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let cmd: { id: string; type: string; runId?: string; input?: { run?: { runId?: string } } };
      try {
        cmd = JSON.parse(line);
      } catch {
        out({ id: "", type: "response", command: "execute", success: false, error: "malformed" });
        continue;
      }
      if (cmd.type === "execute") {
        const runId = cmd.input?.run?.runId ?? "unknown";
        if (scenario === "reject-first-execute") {
          // Shared state across child processes: the FIRST execute anywhere
          // rejects; every later one accepts. The record is checked BEFORE
          // this child appends its own line.
          const seen = record && existsSync(record) ? readFileSync(record, "utf-8") : "";
          if (!seen.includes("execute ")) {
            note("execute", `${runId} ${process.cwd()}`);
            out({
              id: cmd.id,
              type: "response",
              command: "execute",
              success: false,
              error: "simulated execute failure",
            });
            process.exit(0);
          }
        }
        // The record carries the spawn cwd (= Run workspace root) so tests
        // can assert the adapter's spawn cwd contract.
        note("execute", `${runId} ${process.cwd()}`);
        if (cwdMarker) writeFileSync(cwdMarker, process.cwd());
        if (scenario === "silent") {
          // Never respond to execute: models a child stuck pre-acceptance
          // (e.g. it fell into the wrong CLI mode). dispose() must SIGTERM
          // it without ever waiting on the acceptance promise.
          continue;
        }
        if (scenario === "reject-execute") {
          out({
            id: cmd.id,
            type: "response",
            command: "execute",
            success: false,
            error: "simulated execute failure",
          });
          process.exit(0);
        }
        out({ id: cmd.id, type: "response", command: "execute", success: true });
        if (scenario === "exit-before-outcome") {
          setTimeout(() => process.exit(5), 200);
          return;
        }
        if (scenario === "malformed-stdout") {
          process.stdout.write("this is not json\n");
          setTimeout(() => process.exit(1), 50);
          return;
        }
        if (scenario === "stderr-flood") {
          out({ id: cmd.id, type: "response", command: "execute", success: true });
          const secret = process.env.RPC_FIXTURE_SECRET ?? "sekret-value";
          process.stderr.write(`${secret} `.repeat(20_000)); // ~240 KiB
          setTimeout(() => process.exit(1), 50);
          return;
        }
        out({
          id: 1,
          type: "event",
          runId,
          event: { id: 0, type: "agent_start", data: { type: "agent_start" } },
        });
        out({
          id: 2,
          type: "event",
          runId,
          event: {
            id: 1,
            type: "message_update",
            data: { type: "message_update", text: "working" },
          },
        });
        out({
          id: 3,
          type: "event",
          runId,
          event: { id: 2, type: "agent_end", data: { type: "agent_end", status: "completed" } },
        });
        if (scenario === "no-events") {
          // Wait for abort; respond; exit without an outcome.
          continue;
        }
        setTimeout(() => {
          note("outcome", runId);
          out({
            type: "outcome",
            runId,
            outcome: { status: "completed", output: { role: "assistant", text: "done" } },
          });
          setTimeout(() => process.exit(0), 20);
        }, outcomeDelayMs);
        continue;
      }
      if (cmd.type === "steer") {
        note("steer", cmd.runId ?? "?");
        if (scenario === "steer-error") {
          out({
            id: cmd.id,
            type: "response",
            command: "steer",
            success: false,
            error: "steer requires a live run (simulated)",
          });
          continue;
        }
        out({ id: cmd.id, type: "response", command: "steer", success: true });
        continue;
      }
      if (cmd.type === "abort") {
        note("abort", cmd.runId ?? "?");
        out({ id: cmd.id, type: "response", command: "abort", success: true });
        if (scenario === "no-events") {
          // Acknowledge but never emit an outcome: the adapter's bounded
          // grace must kill us and settle aborted.
        }
      }
    }
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`[rpc-fixture] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
