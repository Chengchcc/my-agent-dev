"use client";

// Read-only Monaco viewer. The @monaco-editor/react default loader pulls
// monaco from the CDN, so nothing monaco-specific is bundled at build time;
// the whole component is loaded via next/dynamic at the callsite, so the
// editor JS never touches the first paint. (For offline deployments, add
// `loader.config({ monaco })` with a locally installed monaco-editor.)

import Editor from "@monaco-editor/react";

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = {
    md: "markdown",
    markdown: "markdown",
    yml: "yaml",
    yaml: "yaml",
    json: "json",
    jsonc: "json",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    sh: "shell",
    bash: "shell",
    css: "css",
    html: "html",
    py: "python",
    go: "go",
    rs: "rust",
    txt: "plaintext",
  };
  return byExt[ext] ?? "plaintext";
}

export function MonacoViewer({ value, path }: { value: string; path: string }) {
  // The product UI is dark-only (no ThemeProvider mounted), so pin the
  // editor theme instead of resolving undefined -> light.
  return (
    <div className="overflow-hidden rounded-md border border-(--hairline)">
      <Editor
        height="24rem"
        language={languageFor(path)}
        theme="vs-dark"
        value={value}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: "none",
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        }}
      />
    </div>
  );
}
