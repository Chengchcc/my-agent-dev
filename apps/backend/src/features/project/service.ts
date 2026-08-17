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
  /** C2: whether any conversation binds this project. */
  hasProjectBinding?: (projectId: string) => boolean;
}

/** C1: repoUrl and defaultBranch are inserted into git commands. Reject
 *  values that could smuggle options or traverse refs: leading dashes,
 *  whitespace, path separators. Accept https/ssh/file URLs and absolute
 *  or relative local paths. */
function validateRepoRefs(
  repoUrl: string | null | undefined,
  defaultBranch: string | null | undefined,
): void {
  if (repoUrl) {
    const u = repoUrl.trim();
    if (!u) throw new ValidationError("repoUrl must not be empty");
    if (u.startsWith("-")) throw new ValidationError("repoUrl must not start with '-'");
    const schemeOk = /^(https|ssh|file):\/\//.test(u);
    const localPath = u.startsWith("/") || u.startsWith(".");
    if (!schemeOk && !localPath) {
      throw new ValidationError("repoUrl must be an https/ssh/file URL or a local path");
    }
  }
  if (defaultBranch) {
    const b = defaultBranch.trim();
    if (b.startsWith("-")) throw new ValidationError("defaultBranch must not start with '-'");
    if (/[\s/\\]|\\.\\./.test(b)) {
      throw new ValidationError("defaultBranch must not contain whitespace or path separators");
    }
  }
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
      validateRepoRefs(input.repoUrl, input.defaultBranch);
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
      validateRepoRefs(patch.repoUrl, patch.defaultBranch);
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
      // C2: conversations reference the project (FK RESTRICT would
      // surface as a raw 500 — fail with a readable 409 instead).
      if (deps.hasProjectBinding?.(id)) {
        throw new ConflictError(`project ${id} is bound to conversations; remove them first`);
      }
      if (!port.deleteProject(id)) throw new ProjectNotFoundError(id);
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
