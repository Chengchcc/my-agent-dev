import {
  ConflictError,
  ValidationError as DomainValidationError,
  NotFoundError,
} from "../../infra/domain-errors.js";
import type { ProjectRow } from "./domain.js";
import type { ProjectPort } from "./ports.js";

export class ProjectNotFoundError extends NotFoundError {
  constructor(id: string) {
    super("Project", id);
  }
}

// Re-export for existing callers that import ValidationError from project/service
export class ValidationError extends DomainValidationError {}

export interface ProjectServiceDeps {
  port: ProjectPort;
  idGen: () => string;
  now?: () => number;
  /** Agent configs for the detach guard (ADR 0023): deleting a project
   *  that agents still attach to is refused with their ids. */
  listAgentConfigs?: () => Promise<Array<{ id: string; projects: string[] }>>;
}

export function createProjectService(deps: ProjectServiceDeps) {
  const { port, idGen } = deps;
  const now = deps.now ?? Date.now;

  return {
    port,

    createProject(input: {
      name: string;
      repoUrl?: string | null;
      defaultBranch?: string | null;
    }): ProjectRow {
      const name = input.name.trim();
      if (!name) throw new ValidationError("project name required");
      try {
        return port.createProject({
          projectId: idGen(),
          name,
          repoUrl: input.repoUrl ?? null,
          defaultBranch: input.defaultBranch ?? null,
          createdAt: now(),
        });
      } catch (err) {
        // SQLite unique constraint on name → friendly 400
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          throw new ValidationError("project name already exists");
        }
        throw err;
      }
    },

    getById(id: string): ProjectRow {
      const p = port.getProject(id);
      if (!p) throw new ProjectNotFoundError(id);
      return p;
    },

    list(): ProjectRow[] {
      return port.listProjects();
    },

    exists(id: string): boolean {
      return port.getProject(id) !== null;
    },

    update(
      id: string,
      patch: {
        name?: string;
        repoUrl?: string | null;
        defaultBranch?: string | null;
      },
    ): ProjectRow {
      if (patch.name !== undefined && !patch.name.trim()) {
        throw new ValidationError("project name must not be empty");
      }
      try {
        const p = port.updateProject(id, {
          name: patch.name?.trim() || undefined,
          repoUrl: patch.repoUrl,
          defaultBranch: patch.defaultBranch,
          updatedAt: now(),
        });
        if (!p) throw new ProjectNotFoundError(id);
        return p;
      } catch (err) {
        // SQLite unique constraint on name → friendly 400
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          throw new ValidationError("project name already exists");
        }
        throw err;
      }
    },

    async remove(id: string): Promise<void> {
      const agents = (await deps.listAgentConfigs?.()) ?? [];
      const attached = agents.filter((a) => a.projects.includes(id));
      if (attached.length > 0) {
        throw new ConflictError(
          `project ${id} is still attached to: ${attached.map((a) => a.id).join(", ")}`,
        );
      }
      if (!port.deleteProject(id)) throw new ProjectNotFoundError(id);
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
