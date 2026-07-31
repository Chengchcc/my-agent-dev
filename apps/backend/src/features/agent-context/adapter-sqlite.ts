import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { ulid } from "../../infra/ids.js";
import type { AgentContextEntry, BackendSessionBinding, ContextBranch } from "./domain.js";
import { ContextBranchNotFoundError, ContextRevisionConflictError } from "./domain.js";
import type {
  AgentContextPort,
  AppendEntryInput,
  BranchMutationResult,
  ForkBranchInput,
  IdGenerator,
} from "./ports.js";

interface EntryRow {
  entryId: string;
  treeId: string;
  parentId: string | null;
  type: string;
  payload: string;
  ledgerSeq: number | null;
  createdAt: number;
}

function parseEntry(row: EntryRow): AgentContextEntry {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const base = {
    entryId: row.entryId,
    parentId: row.parentId,
    createdAt: row.createdAt,
  };
  switch (row.type) {
    case "ledger_message":
      return { ...base, type: "ledger_message", ledgerSeq: row.ledgerSeq ?? 0 };
    case "private_message":
      return { ...base, type: "private_message", message: payload.message as never };
    case "product_tool_exchange":
      return {
        ...base,
        type: "product_tool_exchange",
        toolName: payload.toolName as string,
        callResult: (payload.callResult as Record<string, unknown>) ?? {},
      };
    case "summary":
      return {
        ...base,
        type: "summary",
        summary: payload.summary as string,
        coversThroughEntryId: payload.coversThroughEntryId as string,
      };
    case "model_change":
      return { ...base, type: "model_change", model: payload.model as never };
    default:
      throw new Error(`Unknown entry type: ${row.type}`);
  }
}

function parseBranch(row: typeof schema.agentContextBranch.$inferSelect): ContextBranch {
  return {
    branchId: row.branchId,
    treeId: row.treeId,
    leafEntryId: row.leafEntryId,
    ledgerCursor: row.ledgerCursor,
    backendKind: row.backendKind,
    isDefault: row.isDefault !== 0,
    revision: row.revision,
    createdAt: row.createdAt,
  };
}

export function sqliteAgentContextAdapter(
  db: Database,
  idGen: IdGenerator = { ulid },
): AgentContextPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    async getOrCreateTree(conversationId, agentMemberId) {
      const existing = d
        .select()
        .from(schema.agentContextTree)
        .where(
          and(
            eq(schema.agentContextTree.conversationId, conversationId),
            eq(schema.agentContextTree.agentMemberId, agentMemberId),
          ),
        )
        .get();
      if (existing) {
        return {
          treeId: existing.treeId,
          conversationId: existing.conversationId,
          agentMemberId: existing.agentMemberId,
          createdAt: existing.createdAt,
        };
      }
      const member = d
        .select()
        .from(schema.member)
        .where(
          and(
            eq(schema.member.conversationId, conversationId),
            eq(schema.member.memberId, agentMemberId),
          ),
        )
        .get();
      if (!member) {
        throw new Error(`Member not found: (${conversationId}, ${agentMemberId})`);
      }
      if (member.kind !== "agent") {
        throw new Error(`Member is not an agent: (${conversationId}, ${agentMemberId})`);
      }
      const treeId = idGen.ulid();
      try {
        d.insert(schema.agentContextTree)
          .values({ treeId, conversationId, agentMemberId, createdAt: Date.now() })
          .run();
      } catch {
        const raced = d
          .select()
          .from(schema.agentContextTree)
          .where(
            and(
              eq(schema.agentContextTree.conversationId, conversationId),
              eq(schema.agentContextTree.agentMemberId, agentMemberId),
            ),
          )
          .get();
        if (!raced) throw new Error("Tree creation race but not found");
        return {
          treeId: raced.treeId,
          conversationId: raced.conversationId,
          agentMemberId: raced.agentMemberId,
          createdAt: raced.createdAt,
        };
      }
      return { treeId, conversationId, agentMemberId, createdAt: Date.now() };
    },

    async getTree(conversationId, agentMemberId) {
      const row = d
        .select()
        .from(schema.agentContextTree)
        .where(
          and(
            eq(schema.agentContextTree.conversationId, conversationId),
            eq(schema.agentContextTree.agentMemberId, agentMemberId),
          ),
        )
        .get();
      return row
        ? {
            treeId: row.treeId,
            conversationId: row.conversationId,
            agentMemberId: row.agentMemberId,
            createdAt: row.createdAt,
          }
        : null;
    },

    async getTreeById(treeId) {
      const row = d
        .select()
        .from(schema.agentContextTree)
        .where(eq(schema.agentContextTree.treeId, treeId))
        .get();
      return row
        ? {
            treeId: row.treeId,
            conversationId: row.conversationId,
            agentMemberId: row.agentMemberId,
            createdAt: row.createdAt,
          }
        : null;
    },

    async getOrCreateDefaultBranch(treeId, backendKind) {
      const existing = d
        .select()
        .from(schema.agentContextBranch)
        .where(
          and(
            eq(schema.agentContextBranch.treeId, treeId),
            eq(schema.agentContextBranch.isDefault, 1),
          ),
        )
        .get();
      if (existing) return parseBranch(existing);

      const branchId = idGen.ulid();
      const now = Date.now();
      try {
        d.insert(schema.agentContextBranch)
          .values({
            branchId,
            treeId,
            leafEntryId: null,
            ledgerCursor: 0,
            backendKind,
            isDefault: 1,
            revision: 1,
            createdAt: now,
          })
          .run();
      } catch {
        const raced = d
          .select()
          .from(schema.agentContextBranch)
          .where(
            and(
              eq(schema.agentContextBranch.treeId, treeId),
              eq(schema.agentContextBranch.isDefault, 1),
            ),
          )
          .get();
        if (!raced) throw new Error("Default branch race but not found");
        return parseBranch(raced);
      }
      return {
        branchId,
        treeId,
        leafEntryId: null,
        ledgerCursor: 0,
        backendKind,
        isDefault: true,
        revision: 1,
        createdAt: now,
      };
    },

    async getBranch(branchId) {
      const row = d
        .select()
        .from(schema.agentContextBranch)
        .where(eq(schema.agentContextBranch.branchId, branchId))
        .get();
      return row ? parseBranch(row) : null;
    },

    async listEntriesToLeaf(branchId) {
      const branch = d
        .select()
        .from(schema.agentContextBranch)
        .where(eq(schema.agentContextBranch.branchId, branchId))
        .get();
      if (!branch) throw new ContextBranchNotFoundError(branchId);
      if (!branch.leafEntryId) return [];

      const entries: EntryRow[] = [];
      let currentId: string | null = branch.leafEntryId;
      while (currentId) {
        const row = d
          .select()
          .from(schema.agentContextEntry)
          .where(eq(schema.agentContextEntry.entryId, currentId))
          .get() as EntryRow | undefined;
        if (!row) break;
        entries.push(row);
        currentId = row.parentId;
      }
      return entries.reverse().map(parseEntry);
    },

    async appendEntry(input: AppendEntryInput): Promise<BranchMutationResult> {
      const entryId = idGen.ulid();
      const now = Date.now();

      // Atomic transaction: validate -> insert entry -> CAS update branch.
      // If any step fails the transaction rolls back, leaving no dangling state.
      const txn = db.transaction(() => {
        // 1. Read branch and validate revision
        const branch = d
          .select()
          .from(schema.agentContextBranch)
          .where(eq(schema.agentContextBranch.branchId, input.branchId))
          .get();
        if (!branch) throw new ContextBranchNotFoundError(input.branchId);
        if (branch.revision !== input.expectedRevision) {
          throw new ContextRevisionConflictError(input.branchId, input.expectedRevision);
        }

        // 2. Validate parentId equals current leafEntryId (tree integrity)
        if (input.parentId !== branch.leafEntryId) {
          throw new Error(
            `append parentId ${input.parentId} must equal current branch leaf ${branch.leafEntryId}`,
          );
        }

        // 3. Validate parent entry exists and belongs to the same tree
        if (input.parentId) {
          const parentRow = d
            .select()
            .from(schema.agentContextEntry)
            .where(eq(schema.agentContextEntry.entryId, input.parentId))
            .get();
          if (!parentRow) {
            throw new Error(`Parent entry ${input.parentId} not found`);
          }
          if (parentRow.treeId !== branch.treeId) {
            throw new Error(`Parent entry ${input.parentId} belongs to a different tree`);
          }
        }

        // 4. Insert the entry FIRST (before branch update)
        d.insert(schema.agentContextEntry)
          .values({
            entryId,
            treeId: branch.treeId,
            parentId: input.parentId,
            type: input.type,
            payload: JSON.stringify(input.payload),
            ledgerSeq: input.ledgerSeq ?? null,
            createdAt: now,
          })
          .run();

        // 5. THEN CAS update branch leaf/revision - must use returning() to
        //    detect concurrent CAS failures; on 0 rows the transaction rolls back.
        const updatedBranch = d
          .update(schema.agentContextBranch)
          .set({
            leafEntryId: entryId,
            revision: input.expectedRevision + 1,
          })
          .where(
            and(
              eq(schema.agentContextBranch.branchId, input.branchId),
              eq(schema.agentContextBranch.revision, input.expectedRevision),
            ),
          )
          .returning()
          .get();

        if (!updatedBranch) {
          throw new ContextRevisionConflictError(input.branchId, input.expectedRevision);
        }
        // 6. Mark execution session binding stale: Context advanced while
        //    the backend was not running, so the cached session is out of date.
        d.update(schema.backendSessionBinding)
          .set({ state: "stale", updatedAt: Date.now() })
          .where(eq(schema.backendSessionBinding.branchId, input.branchId))
          .run();

        return {
          branch: parseBranch(updatedBranch),
          entryId,
        } satisfies BranchMutationResult;
      });

      return txn();
    },

    async forkBranch(input: ForkBranchInput) {
      const txn = db.transaction(() => {
        const source = d
          .select()
          .from(schema.agentContextBranch)
          .where(eq(schema.agentContextBranch.branchId, input.sourceBranchId))
          .get();
        if (!source) throw new ContextBranchNotFoundError(input.sourceBranchId);
        if (source.revision !== input.expectedRevision) {
          throw new ContextRevisionConflictError(input.sourceBranchId, input.expectedRevision);
        }

        // Validate fromEntryId exists and belongs to source tree, and is on the branch path
        const fromEntry = d
          .select()
          .from(schema.agentContextEntry)
          .where(eq(schema.agentContextEntry.entryId, input.fromEntryId))
          .get();
        if (!fromEntry) throw new Error(`fromEntryId ${input.fromEntryId} not found`);
        if (fromEntry.treeId !== source.treeId) {
          throw new Error(`fromEntryId ${input.fromEntryId} does not belong to source tree`);
        }
        // Verify the entry is on the source branch path (inline walk, sync)
        let onPath = false;
        let walkId: string | null = source.leafEntryId;
        while (walkId) {
          if (walkId === input.fromEntryId) {
            onPath = true;
            break;
          }
          const row = d
            .select()
            .from(schema.agentContextEntry)
            .where(eq(schema.agentContextEntry.entryId, walkId))
            .get();
          walkId = row?.parentId ?? null;
        }
        if (!onPath) {
          throw new Error(`fromEntryId ${input.fromEntryId} is not on the source branch path`);
        }

        const newBackendKind = input.backendKind ?? source.backendKind;
        const branchId = idGen.ulid();
        const now = Date.now();

        d.insert(schema.agentContextBranch)
          .values({
            branchId,
            treeId: source.treeId,
            leafEntryId: input.fromEntryId,
            ledgerCursor: source.ledgerCursor,
            backendKind: newBackendKind,
            isDefault: 0,
            revision: 1,
            createdAt: now,
          })
          .run();

        const branch = d
          .select()
          .from(schema.agentContextBranch)
          .where(eq(schema.agentContextBranch.branchId, branchId))
          .get();
        if (!branch) throw new Error("Forked branch not found after insert");
        return { branch: parseBranch(branch) };
      });

      return txn();
    },

    async moveBranchLeaf(branchId, expectedRevision, newLeafEntryId) {
      return db.transaction(() => {
        const branch = d
          .select()
          .from(schema.agentContextBranch)
          .where(eq(schema.agentContextBranch.branchId, branchId))
          .get();
        if (!branch) throw new ContextBranchNotFoundError(branchId);

        // Validate newLeafEntryId exists and belongs to same tree
        const entry = d
          .select()
          .from(schema.agentContextEntry)
          .where(eq(schema.agentContextEntry.entryId, newLeafEntryId))
          .get();
        if (!entry) throw new Error(`newLeafEntryId ${newLeafEntryId} not found`);
        if (entry.treeId !== branch.treeId) {
          throw new Error(`newLeafEntryId ${newLeafEntryId} does not belong to branch tree`);
        }

        const result = d
          .update(schema.agentContextBranch)
          .set({
            leafEntryId: newLeafEntryId,
            revision: expectedRevision + 1,
          })
          .where(
            and(
              eq(schema.agentContextBranch.branchId, branchId),
              eq(schema.agentContextBranch.revision, expectedRevision),
            ),
          )
          .returning()
          .get();

        if (!result) {
          throw new ContextRevisionConflictError(branchId, expectedRevision);
        }

        // Mark binding stale
        d.update(schema.backendSessionBinding)
          .set({ state: "stale", updatedAt: Date.now() })
          .where(eq(schema.backendSessionBinding.branchId, branchId))
          .run();

        return parseBranch(result);
      })();
    },

    async markBindingStale(branchId) {
      d.update(schema.backendSessionBinding)
        .set({ state: "stale", updatedAt: Date.now() })
        .where(eq(schema.backendSessionBinding.branchId, branchId))
        .run();
    },

    async upsertBinding(binding: BackendSessionBinding) {
      const now = Date.now();
      d.insert(schema.backendSessionBinding)
        .values({
          branchId: binding.branchId,
          backendSessionId: binding.backendSessionId,
          backendKind: binding.backendKind,
          syncedEntryId: binding.syncedEntryId,
          syncedRevision: binding.syncedRevision,
          state: binding.state,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.backendSessionBinding.branchId,
          set: {
            backendSessionId: binding.backendSessionId,
            backendKind: binding.backendKind,
            syncedEntryId: binding.syncedEntryId,
            syncedRevision: binding.syncedRevision,
            state: binding.state,
            updatedAt: now,
          },
        })
        .run();

      const row = d
        .select()
        .from(schema.backendSessionBinding)
        .where(eq(schema.backendSessionBinding.branchId, binding.branchId))
        .get();
      if (!row) throw new Error("Binding not found after upsert");
      return {
        branchId: row.branchId,
        backendSessionId: row.backendSessionId,
        backendKind: row.backendKind,
        syncedEntryId: row.syncedEntryId,
        syncedRevision: row.syncedRevision,
        state: row.state as "active" | "stale" | "detached",
        updatedAt: row.updatedAt,
      };
    },

    async getBinding(branchId) {
      const row = d
        .select()
        .from(schema.backendSessionBinding)
        .where(eq(schema.backendSessionBinding.branchId, branchId))
        .get();
      if (!row) return null;
      return {
        branchId: row.branchId,
        backendSessionId: row.backendSessionId,
        backendKind: row.backendKind,
        syncedEntryId: row.syncedEntryId,
        syncedRevision: row.syncedRevision,
        state: row.state as "active" | "stale" | "detached",
        updatedAt: row.updatedAt,
      };
    },
  };
}
