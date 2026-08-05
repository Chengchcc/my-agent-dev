import type {
  BackendModelRef,
  BackendRunOutcome,
  PendingActionResponse,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
import type { Message } from "@my-agent-team/message";
import type { IdGenerator, LedgerMessageResolver } from "../agent-context/ports.js";
import type { AgentContextService } from "../agent-context/service.js";
import type { AgentRun, BranchInput, BranchInputMode, PendingActionRecord } from "./domain.js";
import type { AgentRunPort } from "./ports.js";

export interface AgentRunServiceDeps {
  readonly port: AgentRunPort;
  readonly contextService: AgentContextService;
  readonly idGen: IdGenerator;
  readonly ledgerResolver: LedgerMessageResolver;
}

/** Product-facing Agent Run service. Manages durable Run creation, queue,
 *  PendingAction, and terminal persistence. Does NOT execute Runs - no
 *  start/send/resume/respond methods. */
export interface AgentRunService {
  /** Enqueue an input and try to acquire a Run for an existing agent member.
   *  Lazily creates the default Context Branch if needed. */
  enqueueAndAcquire(input: {
    conversationId: string;
    agentMemberId: string;
    backendKind: string;
    mode: BranchInputMode;
    message: Message;
    defaultModel: BackendModelRef;
    configRevision: number;
    idempotencyKey: string;
    /** Optional run-level workspace snapshot (e.g. Loop's cloned repo). */
    workspace?: WorkspaceBinding;
  }): Promise<{
    acquired: boolean;
    queued: boolean;
    replayed: boolean;
    /** True when the input was cancelled at enqueue (steer with no active
     *  Run). No run was created. */
    cancelled?: boolean;
    run?: AgentRun;
    inputId: string;
  }>;

  markInputAccepted(inputId: string): Promise<BranchInput>;
  createPendingAction(
    runId: string,
    action: { kind: string; payload: Readonly<Record<string, unknown>> },
  ): Promise<PendingActionRecord>;
  consumePendingAction(
    actionId: string,
    response: PendingActionResponse,
    responseIdempotencyKey: string,
  ): Promise<{ action: PendingActionRecord; runId: string }>;
  finalizeRun(runId: string, outcome: BackendRunOutcome): Promise<AgentRun>;
  getRun(runId: string): Promise<AgentRun | null>;
  getActiveRun(branchId: string): Promise<AgentRun | null>;
  listInputs(branchId: string): Promise<BranchInput[]>;
}

export function createAgentRunService(deps: AgentRunServiceDeps): AgentRunService {
  const { port, contextService, idGen } = deps;

  return {
    async enqueueAndAcquire(input) {
      // Lazily get/create the default branch for this agent member
      const branch = await contextService.getOrCreateDefaultBranch(
        input.conversationId,
        input.agentMemberId,
        input.backendKind,
      );

      const deliveryIdempotencyKey = `${input.idempotencyKey}:delivery`;
      const runIdempotencyKey = `${input.idempotencyKey}:run`;

      return port.enqueueAndAcquire({
        conversationId: input.conversationId,
        agentMemberId: input.agentMemberId,
        branchId: branch.branchId,
        mode: input.mode,
        message: input.message,
        inputIdempotencyKey: input.idempotencyKey,
        runIdempotencyKey,
        deliveryIdempotencyKey,
        defaultModel: input.defaultModel,
        configRevision: input.configRevision,
        expectedRevision: branch.revision,
        workspace: input.workspace,
      });
    },

    async markInputAccepted(inputId) {
      return port.markInputAccepted(inputId);
    },

    async createPendingAction(runId, action) {
      const actionId = idGen.ulid();
      return port.createPendingAction(runId, { actionId, ...action });
    },

    async consumePendingAction(actionId, response, responseIdempotencyKey) {
      return port.consumePendingAction(actionId, response, responseIdempotencyKey);
    },

    async finalizeRun(runId, outcome) {
      return port.finalizeRun(runId, outcome);
    },

    async getRun(runId) {
      return port.getRun(runId);
    },

    async getActiveRun(branchId) {
      return port.getActiveRun(branchId);
    },

    async listInputs(branchId) {
      return port.listInputs(branchId);
    },
  };
}
