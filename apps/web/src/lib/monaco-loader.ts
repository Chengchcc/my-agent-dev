"use client";

import { loader } from "@monaco-editor/react";

// Load Monaco from CDN (avoid bundling SSR). If offline in this environment,
// the editor falls back to the @monaco-editor/react Loading placeholder.
loader.config({
  paths: {
    vs: "/monaco/vs",
  },
});

export { loader };
