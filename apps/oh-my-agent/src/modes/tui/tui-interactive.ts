import { forkSessionAtEvent, loadSessionBranchNodes } from "../../core/session/session-file.js";
import { resolveSession } from "../../core/session/session-loop.js";
import { saveProjectModel } from "../../core/settings/project-settings.js";
import type { TuiSessionContext } from "./tui-commands.js";
import { formatModelMeta } from "./tui-format.js";
import { hydrateTranscript } from "./view-state.js";

export async function listModels(ctx: TuiSessionContext): Promise<string[]> {
  const catalog = await ctx.opts.modelRuntime.getCatalog();
  return catalog.models.map((m) => `${m.providerId}/${m.modelId}`);
}

/** Catalog rows with the pi-browser meta line (ctx / cost / marks). */
export async function listModelRows(
  ctx: TuiSessionContext,
): Promise<Array<{ id: string; meta: string; contextWindow: number }>> {
  const catalog = await ctx.opts.modelRuntime.getCatalog();
  return catalog.models.map((m) => {
    const id = `${m.providerId}/${m.modelId}`;
    return {
      id,
      contextWindow: m.contextWindow,
      meta: formatModelMeta(m, {
        current: id === ctx.modelId,
        contextTokens: ctx.lastContextTokens,
      }),
    };
  });
}

export function lastRunRecap(ctx: TuiSessionContext): string | undefined {
  const run = ctx.state.runs.at(-1);
  if (!run) return undefined;
  for (let i = run.items.length - 1; i >= 0; i--) {
    const item = run.items[i]!;
    if (item.kind === "assistant" && item.text.trim()) {
      return item.text.replace(/\s+/g, " ").trim().slice(0, 120);
    }
  }
  return ctx.sessionTitle;
}

/** ctrl+p: interactive model picker overlay. */
export async function pickModelInteractive(ctx: TuiSessionContext): Promise<void> {
  if (!ctx.io.pickModel) return;
  const rows = await listModelRows(ctx);
  const picked = await ctx.io.pickModel(
    rows.map((r) => ({ id: r.id, label: r.id, description: r.meta })),
  );
  if (!picked) return;
  ctx.modelId = picked;
  saveProjectModel(ctx.opts.workspaceRoot, ctx.modelId);
  ctx.io.setHeader?.({
    model: ctx.modelId,
    sessionId: ctx.session.sessionId,
    title: ctx.sessionTitle,
  });
  ctx.pushStatus(`model: ${ctx.modelId}`);
  ctx.io.render(ctx.state);
}

/** Idle esc-esc: interactive branch-tree fork (omp tree-selector-inspired). */
export async function forkTreeInteractive(ctx: TuiSessionContext): Promise<void> {
  if (ctx.liveRuntime) {
    ctx.pushStatus("cannot fork while a run is live");
    ctx.io.render(ctx.state);
    return;
  }
  if (!ctx.io.pickBranchTree) {
    await ctx.runCommandText?.("/fork");
    return;
  }
  const nodes = loadSessionBranchNodes(ctx.session.sessionId, ctx.session.dir);
  if (nodes.length === 0) {
    ctx.pushStatus("no branch nodes to fork from yet");
    ctx.io.render(ctx.state);
    return;
  }
  const picked = await ctx.io.pickBranchTree(nodes);
  if (picked === null) {
    ctx.pushStatus("fork cancelled");
    ctx.io.render(ctx.state);
    return;
  }
  const parentId = ctx.session.sessionId;
  const newId = forkSessionAtEvent(parentId, picked, ctx.session.dir);
  if (newId === null) {
    ctx.pushStatus("cannot fork at that node");
    ctx.io.render(ctx.state);
    return;
  }
  ctx.session = resolveSession(newId, ctx.session.dir);
  ctx.sessionTitle = undefined;
  hydrateTranscript(ctx.state, ctx.session.messages);
  ctx.io.setHeader?.({ model: ctx.modelId, sessionId: ctx.session.sessionId });
  ctx.pushStatus(
    `forked ${parentId.slice(0, 8)} @ node ${picked.slice(0, 8)} -> ${newId.slice(0, 8)} ` +
      `(${ctx.session.messages.length} messages)`,
  );
  ctx.io.render(ctx.state);
}

/** Wire the one keyboard/command handler + focus recap for the session. */
export function registerIoHandlers(ctx: TuiSessionContext): void {
  ctx.io.onCommand?.((cmd) => {
    if (cmd === "toggleThinking") {
      ctx.state.showThinking = !ctx.state.showThinking;
    } else if (cmd === "toggleToolDetail") {
      ctx.state.showToolDetail = !ctx.state.showToolDetail;
    } else if (cmd === "pickModel") {
      void pickModelInteractive(ctx);
    } else if (cmd === "forkTree") {
      void forkTreeInteractive(ctx);
    } else if (ctx.liveRuntime) {
      void ctx.liveRuntime.stop().catch(() => {});
    }
    ctx.io.render(ctx.state);
  });
  ctx.io.onFocus?.((focusedNow) => {
    if (!focusedNow) return;
    if (!ctx.pendingFocusRecap) return;
    const recap = ctx.pendingFocusRecap;
    ctx.pendingFocusRecap = undefined;
    ctx.pushStatus(`recap: ${recap}`);
    ctx.io.render(ctx.state);
  });
}
