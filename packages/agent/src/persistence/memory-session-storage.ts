import type { SessionStorage } from "./session-storage.js";
import type { SessionTreeEntry } from "./session-tree.js";

/**
 * 内存实现 -- Map<id, entry> + leafId 状态。
 * getPathToRoot 从 leaf 沿 parentId 链回溯到根，返回顺序为根 -> 叶。
 */
export function memorySessionStorage(): SessionStorage {
  const entries = new Map<string, SessionTreeEntry>();
  const order: string[] = []; // 插入顺序
  let leafId: string | null = null;

  return {
    getLeafId() {
      return leafId;
    },
    async setLeafId(id) {
      leafId = id;
    },
    createEntryId() {
      return crypto.randomUUID();
    },
    async appendEntry(entry) {
      if (entry.parentId !== null && !entries.has(entry.parentId)) {
        throw new Error(`memorySessionStorage.appendEntry: parentId ${entry.parentId} not found`);
      }
      entries.set(entry.id, entry);
      order.push(entry.id);
    },
    getEntry(id) {
      return entries.get(id);
    },
    getPathToRoot(fromLeafId) {
      if (fromLeafId === null) return [];
      const chain: SessionTreeEntry[] = [];
      let cur: SessionTreeEntry | undefined = entries.get(fromLeafId);
      // ponytail: 简单回溯，无环检测 -- 树由 appendEntry 的 parentId 约束保证
      while (cur !== undefined) {
        chain.push(cur);
        cur = cur.parentId === null ? undefined : entries.get(cur.parentId);
      }
      return chain.reverse();
    },
    getEntries() {
      return order.map((id) => entries.get(id) as SessionTreeEntry);
    },
  };
}
