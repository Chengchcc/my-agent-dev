import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const modelRuntime = createModelRuntime();
  const app = createCodingAgentApp({ config, modelRuntime });
  const server = createServer(config, app);

  server.start();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.stop();
    server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[coding-agent] startup failed:", err);
    process.exit(1);
  });
}
