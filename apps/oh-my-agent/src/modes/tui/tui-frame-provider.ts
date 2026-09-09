import type { Container, Editor, TerminalFrameProvider } from "@chengchenccc/tui";
import type { OmaTranscriptContainer } from "./tui-components.js";
import type { TuiRenderShell } from "./tui-render.js";

export interface OmaFrameProviderOptions {
  transcript: OmaTranscriptContainer;
  statusContainer: Container;
  editor: Editor;
  shell: TuiRenderShell;
}

/** Composes the bounded mutable viewport (live transcript tail + status/
 *  editor). The header prints INTO the transcript once per session
 *  (cc-style) and scrolls away with content — it is not live chrome. */
export function createOmaFrameProvider({
  transcript,
  statusContainer,
  editor,
  shell,
}: OmaFrameProviderOptions): TerminalFrameProvider {
  return {
    renderFrame({ columns, rows }) {
      const width = columns;
      const after = [...statusContainer.render(width), ...editor.render(width)];
      const available = Math.max(0, rows - after.length);
      const target = Math.max(0, shell.lastTotalRows - available);
      const boundary = Math.min(shell.lastLiveStartRow, target);
      transcript.setNativeScrollbackCommittedRows(boundary);
      const active = available > 0 ? transcript.renderViewport(width, available) : [];
      const viewport = [...active, ...after];
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
