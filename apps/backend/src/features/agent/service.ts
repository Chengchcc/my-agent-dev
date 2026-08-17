import { writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { BusyError, NotFoundError, ValidationError } from "../../infra/domain-errors.js";
import { buildAgentConfig, serializeAgentYaml } from "./agent-config.js";
import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";
import type { AgentPort } from "./ports.js";
import { ensureAgentWorkspace } from "./workspace.js";

export interface AgentService {
  create(input: CreateAgentInput): Promise<AgentRow>;
  getById(id: string): Promise<AgentRow>;
  /** Check if an agent exists and is not archived. Single-row lookup, no full scan. */
  exists(id: string): Promise<boolean>;
  list(includeArchived?: boolean): Promise<AgentRow[]>;
  update(id: string, input: UpdateAgentInput): Promise<AgentRow>;
  archive(id: string): Promise<AgentRow>;
  /** M11: Permanently delete agent across backend.db + workspace. Requires no active runs. */
  hardDelete(id: string): Promise<void>;
}

export function createAgentService(opts: {
  port: AgentPort;
  idGen: () => string;
  workspaceRoot: string;
  materializeWorkspace: (agentId: string, template?: string, name?: string) => Promise<string>;
  // M11 hardDelete dependencies — all closures from composition root (main.ts)
  purgeWorkspace: (agentId: string) => Promise<void>;
  /** Guard: throws BusyError when the agent has an ACTIVE Agent Run
   *  (running/waiting/commit_failed). Agent Run is the only execution
   *  identity in Phase 5 - old session/attempt queries are gone. */
  assertNoActiveRun: (agentId: string) => void;
  /** Optional hook called after agent creation (e.g. assign builtin skill pack). */
  onCreate?: (agentId: string) => Promise<void>;
  /** Optional hook called after agent update (e.g. workspace-bridge reconcile). */
  onUpdate?: (agentId: string, prevProjects: string[]) => Promise<void>;
  /** Absolute roots an HTTP workspace override may live under (D4: the
   *  workspaceRoot + the managed agents dir). Outside = ValidationError. */
  allowedWorkspaceRoots?: readonly string[];
}): AgentService {
  const { port, idGen, materializeWorkspace, onCreate, onUpdate } = opts;

  return {
    async create(input: CreateAgentInput): Promise<AgentRow> {
      const id = input.id ?? idGen();
      // Agent-level workspace override (ADR 0020): a configured absolute
      // path is materialized verbatim (mkdir -p + seeded defaults);
      // otherwise fall back to the managed <dataDir>/agents/<id> location.
      const overridePath = input.workspacePath;
      const workspacePath = overridePath
        ? await (async () => {
            const abs = resolve(overridePath);
            const allowed =
              opts.allowedWorkspaceRoots?.some(
                (root) => abs === root || abs.startsWith(`${root}${sep}`),
              ) ?? false;
            if (!allowed) {
              throw new ValidationError(
                `workspace override ${abs} is outside the allowed roots: ${opts.allowedWorkspaceRoots?.join(", ") ?? "none"}`,
              );
            }
            return ensureAgentWorkspace(abs);
          })()
        : await materializeWorkspace(id, input.template, input.id ? undefined : input.name);

      const config = buildAgentConfig({
        id,
        name: input.name,
        model: input.model,
        backendKind: input.backendKind,
        enabled: input.enabled,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode,
        maxSteps: input.maxSteps,
        lark: input.lark
          ? {
              enabled: input.lark.enabled,
              appId: input.lark.appId,
              botDisplayName: input.lark.botDisplayName,
            }
          : undefined,
      });

      // agent.yml is the single source (ADR 0020): write it into the
      // workspace, then cache the parsed form in the DB.
      await writeFile(join(workspacePath, "agent.yml"), serializeAgentYaml(config), "utf-8");

      const row = await port.create({ id, workspacePath, config, now: Date.now() });
      await onCreate?.(id);
      return row;
    },

    async getById(id: string): Promise<AgentRow> {
      const row = await port.findById(id);
      if (!row || row.archivedAt) throw new AgentNotFoundError(id);
      return row;
    },

    async exists(id: string): Promise<boolean> {
      const row = await port.findById(id);
      return row !== null && row.archivedAt == null;
    },

    async list(includeArchived = false): Promise<AgentRow[]> {
      return port.list(includeArchived);
    },

    async update(id: string, input: UpdateAgentInput): Promise<AgentRow> {
      const existing = await port.findById(id);
      if (!existing || existing.archivedAt) throw new AgentNotFoundError(id);

      const config = buildAgentConfig({
        id,
        name: input.name,
        model: input.model,
        backendKind: input.backendKind,
        enabled: input.enabled,
        reasoningEffort: input.reasoningEffort,
        permissionMode: input.permissionMode,
        maxSteps: input.maxSteps,
        mcpServers: input.mcpServers,
        knowledgePacks: input.knowledgePacks,
        projects: input.projects,
        lark: input.lark
          ? {
              enabled: input.lark.enabled,
              appId: input.lark.appId,
              botDisplayName: input.lark.botDisplayName,
            }
          : undefined,
        prev: existing.config,
      });

      // Workspace relocation: materialize + seed the new path before the
      // row points at it; the file write stays at the (new) source.
      let workspacePath = existing.workspacePath;
      if (input.workspacePath !== undefined && input.workspacePath !== existing.workspacePath) {
        workspacePath = await ensureAgentWorkspace(resolve(input.workspacePath));
      }
      await writeFile(join(workspacePath, "agent.yml"), serializeAgentYaml(config), "utf-8");

      const row = await port.update(id, {
        config,
        now: Date.now(),
        ...(workspacePath !== existing.workspacePath ? { workspacePath } : {}),
      });
      if (!row) throw new AgentNotFoundError(id);
      await onUpdate?.(id, existing.config.runtime_config.projects);
      return row;
    },

    async archive(id: string): Promise<AgentRow> {
      const row = await port.archive(id, Date.now());
      if (!row) throw new AgentNotFoundError(id);
      return row;
    },

    // M11: Hard delete across stores — backend.db (transactional), workspace
    async hardDelete(id: string): Promise<void> {
      // 0. Verify agent exists (throws AgentNotFoundError if not)
      const existing = await port.findById(id);
      if (!existing || existing.archivedAt) throw new AgentNotFoundError(id);
      // 1. Guard: no active Agent Run (running/waiting/commit_failed)
      opts.assertNoActiveRun(id);
      // 2. DB: hard delete the agent row + cascade
      const result = await port.hardDelete(id);
      if (!result.deletedAgent) throw new AgentNotFoundError(id);
      // 3. workspace: physical rm -rf (idempotent)
      await opts.purgeWorkspace(id);
    },
  };
}

export class AgentNotFoundError extends NotFoundError {
  constructor(id: string) {
    super("Agent", id);
  }
}

export class AgentBusyError extends BusyError {}
