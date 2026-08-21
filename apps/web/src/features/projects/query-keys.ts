export const projectKeys = {
  all: ["projects"] as const,
  list: () => [...projectKeys.all, "list"] as const,
  detail: (id: string) => ["project", id] as const,
  worktrees: (id: string) => ["project-worktrees", id] as const,
  worktreeDiff: (id: string, agentId: string) => ["project-worktree-diff", id, agentId] as const,
};
