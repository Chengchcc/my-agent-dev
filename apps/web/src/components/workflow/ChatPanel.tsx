"use client";

/**
 * v2 placeholder: natural-language chat that lets an agent produce a DSL
 * patch, which the user applies to the canvas. v1 ships the tab but no LLM
 * wiring — changing the DSL still goes through the DslEditorPanel.
 */
export function ChatPanel() {
  return (
    <div className="p-4 text-xs text-muted-foreground">
      <div className="mb-2 text-sm font-semibold">Chat</div>
      v2: 用自然语言让 agent 生成 DSL patch，应用到画布。本轮占位。
    </div>
  );
}
