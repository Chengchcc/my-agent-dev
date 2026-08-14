import type { AgentConfig } from "./agent-config.js";
import type { AgentRow } from "./domain.js";

/** Storage port for agents (file-first, ADR 0003 decision 1): the row
 *  carries only the FK anchor, the workspace location and the
 *  materialized `config` (parsed agent.yml). */
export interface AgentPort {
  create(input: {
    id: string;
    workspacePath: string;
    config: AgentConfig;
    now: number;
  }): Promise<AgentRow>;
  findById(id: string): Promise<AgentRow | null>;
  list(includeArchived?: boolean): Promise<AgentRow[]>;
  update(
    id: string,
    input: { config: AgentConfig; now: number; workspacePath?: string },
  ): Promise<AgentRow | null>;
  archive(id: string, now: number): Promise<AgentRow | null>;
  /** M11: Permanently delete agent + threads + checkpoints + member rows from backend.db. */
  hardDelete(
    id: string,
  ): Promise<{ deletedAgent: boolean; deletedThreads: number; deletedMembers: number }>;
}
