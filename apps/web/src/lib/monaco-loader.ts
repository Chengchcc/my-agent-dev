"use client";

import { loader } from "@monaco-editor/react";

// Monaco is self-hosted: predev.sh copies node_modules/monaco-editor/min/vs
// to apps/web/public/monaco/vs (gitignored, regenerated per machine). The
// old jsdelivr CDN path made Source/code views hang forever on networks
// where the CDN is unreachable.
const vs = "/monaco/vs";

loader.config({
  paths: { vs },
  "vs/nls": { availableLanguages: { "*": "" } },
});

export { loader };
