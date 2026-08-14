import {
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

    remove(id: string): void {
      if (!port.deleteProject(id)) throw new ProjectNotFoundError(id);
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
