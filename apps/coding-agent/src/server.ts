import type { CodingAgentApp } from "./app.js";
import type { CodingAgentConfig } from "./config.js";

export interface CodingAgentServer {
  start(): void;
  stop(): void;
}

export function createServer(config: CodingAgentConfig, app: CodingAgentApp): CodingAgentServer {
  let server: ReturnType<typeof Bun.serve> | null = null;
  return {
    start() {
      server = Bun.serve({
        port: config.port,
        hostname: config.host,
        idleTimeout: 0, // SSE connections are long-lived
        fetch: app.fetch,
      });
      console.log(`[coding-agent] listening on http://${config.host}:${config.port}`);
    },
    stop() {
      server?.stop();
      server = null;
    },
  };
}
