/** Virtual filesystem interface for agent tools. */
export interface AgentFsLike {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
}

/** Join path segments with "/", collapsing duplicate slashes. */
export function pjoin(...segments: string[]): string {
  return segments.join("/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}
