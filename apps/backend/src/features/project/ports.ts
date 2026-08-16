import type { ProjectRow } from "./domain.js";

export interface CreateProjectRecord {
  projectId: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  createdAt: number;
}

export interface UpdateProjectRecord {
  name?: string;
  repoUrl?: string | null;
  defaultBranch?: string | null;
  updatedAt: number;
}

export interface ProjectPort {
  createProject(input: CreateProjectRecord): ProjectRow;
  getProject(projectId: string): ProjectRow | null;
  listProjects(): ProjectRow[];
  updateProject(projectId: string, patch: UpdateProjectRecord): ProjectRow | null;
  deleteProject(projectId: string): boolean;
}
