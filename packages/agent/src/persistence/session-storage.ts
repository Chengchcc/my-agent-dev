import type { SessionTreeEntry } from "./session-tree.js";

/** 树存储接口 -- 持久化 SessionTreeEntry 树，跟踪当前 leafId。 */
export interface SessionStorage {
  /** 当前叶子节点 id，空树时为 null。 */
  getLeafId(): string | null;
  setLeafId(leafId: string | null): Promise<void>;
  /** 生成新的 entry id（UUID）。 */
  createEntryId(): string;
  /** 追加节点。parentId 必须指向已存在的节点或 null。 */
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  /** 按 id 读取单节点，不存在返回 undefined。 */
  getEntry(id: string): SessionTreeEntry | undefined;
  /** 从 leafId 沿 parentId 链回溯到根，返回顺序为根 -> 叶。leafId=null 返回 []。 */
  getPathToRoot(leafId: string | null): SessionTreeEntry[];
  /** 全部节点（插入顺序）。 */
  getEntries(): SessionTreeEntry[];
}
