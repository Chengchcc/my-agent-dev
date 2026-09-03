import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  // Route renames (UI review 3.5): /work -> /today, /agentic-workflow ->
  // /workflows; team overview flip: /team/agents* -> /team* (agent detail
  // now lives at /team/[agentId]). Old paths keep working via redirects.
  async redirects() {
    return [
      { source: "/work", destination: "/today", permanent: false },
      { source: "/agentic-workflow", destination: "/workflows", permanent: false },
      { source: "/agentic-workflow/:path*", destination: "/workflows/:path*", permanent: false },
      { source: "/team/agents", destination: "/team", permanent: false },
      { source: "/team/agents/:agentId", destination: "/team/:agentId", permanent: false },
    ];
  },
  // The repo lints web with the root flat ESLint + Biome in `bun run lint`;
  // Next's built-in ESLint run has no eslint-config-next installed, so it
  // only emits a plugin-not-detected warning and double-runs lint for free.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
