import { createApp } from "./app.js";
import { installFeatures } from "./bootstrap/features.js";
import { createBackendServices } from "./bootstrap/services.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

// ─── Bootstrap ─────────────────────────────────────────────────

const config = loadConfig();
if (
  config.host !== "127.0.0.1" &&
  config.host !== "localhost" &&
  config.host !== "::1" &&
  config.authToken === "dev-token"
) {
  console.warn(
    `[security] BACKEND_HOST is non-loopback (${config.host}) while BACKEND_AUTH_TOKEN is the` +
      ` documented default "dev-token" (M16). Generate a random token before exposing` +
      ` this backend to any network.`,
  );
}
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

  // The grace period lives INSIDE the child shutdown (abortGraceMs, real
  // child exit), not as a blind sleep before it.
  await installed.dispose();
  await services.mcpClientManager.disconnectAll();
  services.db.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
