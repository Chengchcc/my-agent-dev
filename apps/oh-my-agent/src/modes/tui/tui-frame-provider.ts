import type { Container, Editor, TerminalFrameProvider } from "@chengchenccc/tui";
import type { OmaTranscriptContainer } from "./tui-components.js";
import type { TuiRenderShell } from "./tui-render.js";

export interface OmaFrameProviderOptions {
  headerContainer: Container;
  transcript: OmaTranscriptContainer;
  statusContainer: Container;
  editor: Editor;
  shell: TuiRenderShell;
}

/** Composes the bounded mutable viewport (header + live transcript tail +
 *  status/editor) and offers incremental transcript history for native
 *  scrollback. Header is rendered as live chrome; when the transcript fills
 *  the available rows, settled prefix commits via `history`. */
export function createOmaFrameProvider({
  headerContainer,
  transcript,
  statusContainer,
  editor,
  shell,
}: OmaFrameProviderOptions): TerminalFrameProvider {
  return {
    renderFrame({ columns, rows }) {
      const width = columns;
      const before = headerContainer.render(width);
      const after = [...statusContainer.render(width), ...editor.render(width)];
      const available = Math.max(0, rows - before.length - after.length);
      const target = Math.max(0, shell.lastTotalRows - available);
      const boundary = Math.min(shell.lastLiveStartRow, target);
      transcript.setNativeScrollbackCommittedRows(boundary);
      const active = available > 0 ? transcript.renderViewport(width, available) : [];
      const composed = [...before, ...active, ...after];
      const viewport = composed.length <= rows ? composed : composed.slice(-rows);
      const history = transcript.renderOfferedHistory(width);
      return { viewport, history };
    },
    acknowledgeHistory(id) {
      transcript.acknowledgeFinalizedBatch(id);
    },
    beginHistoryReplay() {
      transcript.beginReplay();
    },
    beginHistoryFlush() {
      transcript.beginHistoryFlush();
    },
  };
}
