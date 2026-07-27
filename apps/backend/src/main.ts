import { createApp } from "./app.js";
import { installFeatures } from "./bootstrap/features.js";
import { createBackendServices } from "./bootstrap/services.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

// ─── Bootstrap ─────────────────────────────────────────────────

const config = loadConfig();
const services = createBackendServices(config);
const installed = await installFeatures(services);

const app = createApp(config.authToken, installed.featureSet);
const server = createServer(config, app);

// ─── Start ────────────────────────────────────────────────────

server.start();
await installed.start();

console.log(`[backend] listening on ${config.host}:${config.port}`);

// ─── Graceful shutdown ────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[backend] ${signal} received, shutting down...`);

  server.stop();
  services.supervisor.cancelAll();

  await Bun.sleep(config.cancelGraceMs);

  await installed.dispose();
  await services.supervisor.dispose();
  await services.mcpClientManager.disconnectAll();
  services.db.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
