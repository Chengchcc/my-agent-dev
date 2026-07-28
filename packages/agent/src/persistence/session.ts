import type { Message } from "@my-agent-team/message";
import type { SessionStorage } from "./session-storage.js";
import type {
  CompactionEntry,
  ModelChangeEntry,
  SessionContext,
  SessionTreeEntry,
} from "./session-tree.js";

/**
 * Session: 一次会话的状态机，底层用 SessionStorage 存储树结构。
 *
 * - appendMessage: 在当前叶子下追加 MessageEntry，并移动叶子到新节点。
 * - buildContext: 从根到当前叶子构建 messages，处理 Compaction 截断。
 * - moveTo: fork -- 把叶子移到任意已有节点，后续 appendMessage 从那里分叉。
 * - getBranch: 回溯 -- 返回从某节点到当前叶子的路径。
 * - appendCompaction: 在当前叶子下追加 CompactionEntry，记录压缩摘要。
 * - appendModelChange: 在当前叶子下追加 ModelChangeEntry。
 */
export class Session {
  constructor(private readonly storage: SessionStorage) {}

  async appendMessage(message: Message): Promise<string> {
    const entryId = this.storage.createEntryId();
    const entry: SessionTreeEntry = {
      type: "message",
      id: entryId,
      parentId: this.storage.getLeafId(),
      timestamp: Date.now(),
      message,
    };
    await this.storage.appendEntry(entry);
    await this.storage.setLeafId(entryId);
    return entryId;
  }

  async appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): Promise<string> {
    const entryId = this.storage.createEntryId();
    const entry: CompactionEntry = {
      type: "compaction",
      id: entryId,
      parentId: this.storage.getLeafId(),
      timestamp: Date.now(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    await this.storage.appendEntry(entry);
    await this.storage.setLeafId(entryId);
    return entryId;
  }

  async appendModelChange(provider: string, modelId: string): Promise<string> {
    const entryId = this.storage.createEntryId();
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: entryId,
      parentId: this.storage.getLeafId(),
      timestamp: Date.now(),
      provider,
      modelId,
    };
    await this.storage.appendEntry(entry);
    await this.storage.setLeafId(entryId);
    return entryId;
  }

  /** Fork: 把当前叶子移到任意已有节点（或 null=空）。后续 append 从此分叉。 */
  async moveTo(entryId: string | null): Promise<void> {
    if (entryId !== null && this.storage.getEntry(entryId) === undefined) {
      throw new Error(`Session.moveTo: entry ${entryId} not found`);
    }
    await this.storage.setLeafId(entryId);
  }

  /** 回溯: 返回从 fromId（默认根）到当前叶子的路径，顺序为根 -> 叶。 */
  async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
    const path = this.storage.getPathToRoot(this.storage.getLeafId());
    if (fromId === undefined) return path;
    const idx = path.findIndex((e) => e.id === fromId);
    if (idx === -1) {
      throw new Error(`Session.getBranch: entry ${fromId} not on current path`);
    }
    return path.slice(idx);
  }

  /**
   * 从根到当前叶子构建 messages，处理 Compaction 截断：
   * - 路径上最新的 CompactionEntry 生效，用其 summary 替换被压缩的消息，
   *   只保留 firstKeptEntryId 及之后的 MessageEntry。
   * - 路径上最后一个 ModelChangeEntry 决定最终 model。
   */
  async buildContext(): Promise<SessionContext> {
    const path = this.storage.getPathToRoot(this.storage.getLeafId());

    // 找到最新（最靠近叶）的 CompactionEntry
    let compactionIdx = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i]!.type === "compaction") {
        compactionIdx = i;
        break;
      }
    }

    let messages: Message[];
    if (compactionIdx !== -1) {
      const compaction = path[compactionIdx] as CompactionEntry;
      // firstKeptEntryId 是 compaction 之前保留的最旧消息；
      // 保留从该条（含）到 compaction（不含）的 message，再接 compaction 之后的 message。
      const keptStart = path.findIndex((e) => e.id === compaction.firstKeptEntryId);
      const before = keptStart === -1 ? [] : path.slice(keptStart, compactionIdx);
      const after = path.slice(compactionIdx + 1);
      const keptMessages = [...before, ...after].filter(
        (e): e is Extract<SessionTreeEntry, { type: "message" }> => e.type === "message",
      );
      // summary 作为一条 system 消息前置
      messages = [
        { role: "system", text: compaction.summary },
        ...keptMessages.map((e) => e.message),
      ];
    } else {
      messages = path
        .filter((e): e is Extract<SessionTreeEntry, { type: "message" }> => e.type === "message")
        .map((e) => e.message);
    }

    // 最后一个 ModelChangeEntry 决定 model
    let model: SessionContext["model"];
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i]!.type === "model_change") {
        const mc = path[i] as ModelChangeEntry;
        model = { provider: mc.provider, modelId: mc.modelId };
        break;
      }
    }

    return { messages, ...(model ? { model } : {}) };
  }
}
