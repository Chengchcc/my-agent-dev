import type { BackendModelRef } from "@my-agent-team/agent-backend";
import type { Message } from "@my-agent-team/message";
import {
  type AgentContextEntry,
  type ContextBranch,
  type ModelChangeEntry,
  validateEntry,
} from "./domain.js";
import type { AgentContextPort, IdGenerator, LedgerMessageResolver } from "./ports.js";

export interface AgentContextServiceDeps {
  readonly port: AgentContextPort;
  readonly idGen: IdGenerator;
  readonly ledgerResolver: LedgerMessageResolver;
}

/** Product-facing Agent Context service. Lazily creates tree/branch for
 *  existing agent members, manages branch operations, and resolves the
 *  effective model for the next Agent Run. */
export interface AgentContextService {
  getOrCreateDefaultBranch(
    conversationId: string,
    agentMemberId: string,
    backendKind: string,
  ): Promise<ContextBranch>;

  appendPrivateMessage(
    branchId: string,
    expectedRevision: number,
    message: Message,
  ): Promise<{ branch: ContextBranch; entryId: string }>;

  appendProductToolExchange(
    branchId: string,
    expectedRevision: number,
    toolName: string,
    callResult: Readonly<Record<string, unknown>>,
  ): Promise<{ branch: ContextBranch; entryId: string }>;

  appendSummary(
    branchId: string,
    expectedRevision: number,
    summary: string,
    coversThroughEntryId: string,
  ): Promise<{ branch: ContextBranch; entryId: string }>;

  changeModel(
    branchId: string,
    expectedRevision: number,
    model: BackendModelRef,
  ): Promise<{ branch: ContextBranch; entryId: string }>;

  forkBranch(
    branchId: string,
    expectedRevision: number,
    fromEntryId: string,
    backendKind?: string,
  ): Promise<{ branch: ContextBranch }>;

  /** Repin the tree's default branch (D2 kind switch). */
  setDefaultBranchKind(
    treeId: string,
    branchId: string,
    backendKind: string,
  ): Promise<ContextBranch>;

  /** Record the branch's CLI session reference (ADR 0019). */
  updateBranchCliSessionRef(branchId: string, cliSessionRef: string): Promise<ContextBranch | null>;

  moveBranchLeaf(
    branchId: string,
    expectedRevision: number,
    newLeafEntryId: string,
  ): Promise<ContextBranch>;

  resolveEffectiveModel(branchId: string, defaultModel: BackendModelRef): Promise<BackendModelRef>;

  listEntriesToLeaf(branchId: string): Promise<AgentContextEntry[]>;
}

export function createAgentContextService(deps: AgentContextServiceDeps): AgentContextService {
  const { port } = deps;

  return {
    async getOrCreateDefaultBranch(conversationId, agentMemberId, backendKind) {
      const tree = await port.getOrCreateTree(conversationId, agentMemberId);
      return port.getOrCreateDefaultBranch(tree.treeId, backendKind);
    },

    async appendPrivateMessage(branchId, expectedRevision, message) {
      const branch = await port.getBranch(branchId);
      if (!branch) throw new Error(`Branch not found: ${branchId}`);
      const result = await port.appendEntry({
        branchId,
        expectedRevision,
        type: "private_message",
        parentId: branch.leafEntryId,
        payload: { message },
      });
      return result;
    },

    async appendProductToolExchange(branchId, expectedRevision, toolName, callResult) {
      const branch = await port.getBranch(branchId);
      if (!branch) throw new Error(`Branch not found: ${branchId}`);
      return port.appendEntry({
        branchId,
        expectedRevision,
        type: "product_tool_exchange",
        parentId: branch.leafEntryId,
        payload: { toolName, callResult },
      });
    },

    async appendSummary(branchId, expectedRevision, summary, coversThroughEntryId) {
      const branch = await port.getBranch(branchId);
      if (!branch) throw new Error(`Branch not found: ${branchId}`);
      // Validate the coverage target is on the branch path
      const entries = await port.listEntriesToLeaf(branchId);
      const targetIdx = entries.findIndex((e) => e.entryId === coversThroughEntryId);
      if (targetIdx === -1) {
        throw new Error(
          `Summary coversThroughEntryId ${coversThroughEntryId} is not on branch ${branchId}`,
        );
      }
      return port.appendEntry({
        branchId,
        expectedRevision,
        type: "summary",
        parentId: branch.leafEntryId,
        payload: { summary, coversThroughEntryId },
      });
    },

    async changeModel(branchId, expectedRevision, model) {
      const branch = await port.getBranch(branchId);
      if (!branch) throw new Error(`Branch not found: ${branchId}`);
      validateEntry(
        {
          type: "model_change",
          entryId: "pending",
          parentId: branch.leafEntryId,
          model,
          createdAt: Date.now(),
        },
        branch.backendKind,
      );
      return port.appendEntry({
        branchId,
        expectedRevision,
        type: "model_change",
        parentId: branch.leafEntryId,
        payload: { model },
      });
    },

    async forkBranch(branchId, expectedRevision, fromEntryId, backendKind) {
      return port.forkBranch({
        sourceBranchId: branchId,
        expectedRevision,
        fromEntryId,
        backendKind,
      });
    },

    async setDefaultBranchKind(treeId, branchId, backendKind) {
      return port.setDefaultBranchKind(treeId, branchId, backendKind);
    },

    async updateBranchCliSessionRef(branchId, cliSessionRef) {
      return port.updateBranchCliSessionRef(branchId, cliSessionRef);
    },

    async moveBranchLeaf(branchId, expectedRevision, newLeafEntryId) {
      return port.moveBranchLeaf(branchId, expectedRevision, newLeafEntryId);
    },

    async resolveEffectiveModel(branchId, defaultModel) {
      const entries = await port.listEntriesToLeaf(branchId);
      // Find the last model_change entry
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry?.type === "model_change") {
          return (entry as ModelChangeEntry).model;
        }
      }
      return defaultModel;
    },

    async listEntriesToLeaf(branchId) {
      return port.listEntriesToLeaf(branchId);
    },
  };
}
