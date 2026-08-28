"use client";

import { loader } from "@monaco-editor/react";

// Load Monaco from CDN (avoid bundling 98MB of assets). If offline, set
// NEXT_PUBLIC_MONACO_VS_PATH to a local `/monaco/vs` (or CDN mirror).
const vs =
  process.env.NEXT_PUBLIC_MONACO_VS_PATH ??
  "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs";

loader.config({
  paths: { vs },
  "vs/nls": { availableLanguages: { "*": "" } },
});

export { loader };
