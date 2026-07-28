import type { Session } from "./session.js";

export interface SessionMetadata {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * SessionRepo -- 会话仓库，管理 Session 的 CRUD + fork。
 *
 * - create: 新建空 Session（生成 UUID + 持久化元数据）。
 * - open: 按 id 打开已存在的 Session（从存储加载树 + leafId）。
 * - list: 列出所有会话元数据。
 * - delete: 删除会话（树 + 元数据）。
 * - fork: 从源会话分叉 -- 创建新会话，复制源会话的 entries（可选从指定 entryId 开始）。
 */
export interface SessionRepo {
  create(options?: { id?: string }): Promise<Session>;
  open(sessionId: string): Promise<Session>;
  list(): Promise<SessionMetadata[]>;
  delete(sessionId: string): Promise<void>;
  fork(sourceSessionId: string, options?: { entryId?: string }): Promise<Session>;
}
