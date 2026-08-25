import {
  deleteSession,
  forkSession,
  listAllSessions,
  listSessions,
  renameSession,
  sessionDirFor,
} from "../../core/session/session-file.js";
import { resolveSession } from "../../core/session/session-loop.js";
import type { CommandDef, TuiSessionContext } from "./tui-commands.js";
import { hydrateTranscript } from "./view-state.js";

export function buildSessionCommands(ctx: TuiSessionContext): CommandDef[] {
  return [
    {
      name: "session",
      description: "show the current session id and title",
      group: "session",
      live: true,
      run: () => {
        ctx.pushStatus(
          `session: ${ctx.session.sessionId}${ctx.sessionTitle ? ` — ${ctx.sessionTitle}` : ""}`,
        );
      },
    },
    {
      name: "resume",
      description: "list/resume sessions (all = every workspace)",
      argumentHint: "<session>",
      group: "session",
      run: async (args) => {
        // "all" = cross-workspace listing (pi's session selector "all"
        // scope); any other arg is an id/prefix within this workspace.
        const all = args === "all";
        const sessions = all ? listAllSessions() : listSessions();
        if (sessions.length === 0) {
          ctx.pushStatus(all ? "no sessions in any workspace" : "no saved sessions");
          return;
        }
        if (!args || all) {
          // Interactive overlay when the ctx.io supports it; text list otherwise.
          if (ctx.io.pickSession) {
            const picked = await ctx.io.pickSession(sessions.slice(0, 20));
            if (!picked) {
              ctx.pushStatus("resume cancelled");
              return;
            }
            const summary = sessions.find((s) => s.id === picked);
            const dir = all && summary?.workspace ? sessionDirFor(summary.workspace) : undefined;
            ctx.session = resolveSession(picked, dir);
            ctx.sessionTitle = summary?.title;
            hydrateTranscript(ctx.state, ctx.session.messages);
            ctx.io.setHeader?.({
              model: ctx.modelId,
              sessionId: ctx.session.sessionId,
              title: ctx.sessionTitle,
            });
            ctx.pushStatus(
              `resumed session: ${ctx.session.sessionId} (${ctx.session.messages.length} messages)`,
            );
            return;
          }
          ctx.pushStatus(
            sessions.slice(0, 20).map((s) => {
              const when = new Date(s.modifiedAt).toISOString().slice(0, 16).replace("T", " ");
              const workspace = s.workspace ? ` [${s.workspace}]` : "";
              const fork = s.forkOf ? ` \u2442 ${s.forkOf.slice(0, 8)}` : "";
              return `${when}  ${s.id}${fork}${workspace}  ${s.title ?? s.preview}`;
            }),
          );
          return;
        }
        const matches = sessions.filter((s) => s.id.startsWith(args));
        if (matches.length === 0) {
          ctx.pushStatus(`no session matches: ${args} (see /resume for the list)`);
          return;
        }
        if (matches.length > 1) {
          ctx.pushStatus(matches.map((s) => `${s.id}  ${s.title ?? s.preview}`));
          return;
        }
        ctx.session = resolveSession(matches[0]!.id, undefined);
        ctx.sessionTitle = matches[0]!.title;
        hydrateTranscript(ctx.state, ctx.session.messages);
        ctx.io.setHeader?.({
          model: ctx.modelId,
          sessionId: ctx.session.sessionId,
          title: ctx.sessionTitle,
        });
        ctx.pushStatus(
          `resumed session: ${ctx.session.sessionId} (${ctx.session.messages.length} messages)`,
        );
      },
    },
    {
      name: "new",
      description: "start a fresh session (clears the transcript)",
      group: "session",
      run: () => {
        ctx.session = resolveSession();
        ctx.sessionTitle = undefined;
        hydrateTranscript(ctx.state, ctx.session.messages);
        ctx.io.setHeader?.({
          model: ctx.modelId,
          sessionId: ctx.session.sessionId,
          title: ctx.sessionTitle,
        });
        ctx.pushStatus(`new session: ${ctx.session.sessionId}`);
      },
    },
    {
      name: "clear",
      description: "clear the transcript view (keeps the session)",
      group: "view",
      run: () => {
        ctx.state.runs.length = 0;
      },
    },
    {
      name: "fork",
      description: "fork the session from an earlier user message",
      argumentHint: "<n>",
      group: "session",
      run: async (args) => {
        // Anchors: user-role messages in the live transcript. Compaction
        // summaries carry role user too; they are legitimate fork points.
        const anchors = ctx.session.messages
          .filter((m) => (m as { role?: string }).role === "user")
          .map((m) => String((m as { text?: string }).text ?? ""));
        if (anchors.length === 0) {
          ctx.pushStatus("no user messages to fork from yet");
          return;
        }
        let ordinal: number | undefined;
        const parsed = Number(args);
        if (args && Number.isInteger(parsed) && parsed >= 1) {
          ordinal = parsed;
        } else if (ctx.io.pickForkPoint) {
          const picked = await ctx.io.pickForkPoint(
            anchors.map((text, i) => ({
              ordinal: i + 1,
              text: text.replace(/\s+/g, " ").slice(0, 60),
            })),
          );
          if (picked === null) {
            ctx.pushStatus("fork cancelled");
            return;
          }
          ordinal = picked;
        } else {
          ctx.pushStatus("usage: /fork <n> (n = user message number)");
          return;
        }
        const parentId = ctx.session.sessionId;
        const newId = forkSession(parentId, ordinal, ctx.session.dir);
        if (newId === null) {
          ctx.pushStatus(`cannot fork: no user message #${ordinal}`);
          return;
        }
        ctx.session = resolveSession(newId, ctx.session.dir);
        ctx.sessionTitle = undefined;
        hydrateTranscript(ctx.state, ctx.session.messages);
        ctx.io.setHeader?.({ model: ctx.modelId, sessionId: ctx.session.sessionId });
        ctx.pushStatus(
          `forked ${parentId.slice(0, 8)} @ msg ${ordinal} -> ${newId.slice(0, 8)} ` +
            `(${ctx.session.messages.length} messages)`,
        );
      },
    },
    {
      name: "rename",
      description: "rename a ctx.session's title",
      argumentHint: "<ctx.session> <title>",
      group: "session",
      run: (args) => {
        const space = args.indexOf(" ");
        if (space <= 0) {
          ctx.pushStatus("usage: /rename <ctx.session-id> <title>");
          return;
        }
        const id = args.slice(0, space).trim();
        const title = args.slice(space + 1).trim();
        if (!title) {
          ctx.pushStatus("usage: /rename <ctx.session-id> <title>");
          return;
        }
        if (!renameSession(id, title)) ctx.pushStatus(`no ctx.session: ${id}`);
        else ctx.pushStatus(`renamed ${id} → ${title}`);
      },
    },
    {
      name: "delete",
      description: "delete a ctx.session file",
      argumentHint: "<session>",
      group: "session",
      run: (args) => {
        if (!args) {
          ctx.pushStatus("usage: /delete <ctx.session-id>");
          return;
        }
        if (!deleteSession(args)) ctx.pushStatus(`no ctx.session: ${args}`);
        else ctx.pushStatus(`deleted ctx.session: ${args}`);
      },
    },
  ];
}
