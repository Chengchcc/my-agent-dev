"use client";

import { loader } from "@monaco-editor/react";

// Load Monaco from CDN (avoid bundling 98MB of assets). To point at a local
// /monaco/vs mirror, change the path below.
const vs = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs";

loader.config({
  paths: { vs },
  "vs/nls": { availableLanguages: { "*": "" } },
});

export { loader };
