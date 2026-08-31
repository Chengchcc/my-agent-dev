import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  // The repo lints web with the root flat ESLint + Biome in `bun run lint`;
  // Next's built-in ESLint run has no eslint-config-next installed, so it
  // only emits a plugin-not-detected warning and double-runs lint for free.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
