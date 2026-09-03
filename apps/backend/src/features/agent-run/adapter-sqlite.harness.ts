import { openDb } from "../../infra/sqlite/db.js";
import { sqliteAgentContextAdapter } from "../agent-context/adapter-sqlite.js";
import type {
  AgentContextPort,
  IdGenerator,
  LedgerMessageResolver,
} from "../agent-context/ports.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentRunAdapter } from "./adapter-sqlite.js";
import type { AgentRunPort } from "./ports.js";

export const db = openDb(":memory:");
const conv = sqliteConversationAdapter(db);

export { conv };

const ctxPort: AgentContextPort = sqliteAgentContextAdapter(db);

export { ctxPort };

const idGen: IdGenerator = { ulid: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26) };
const ledgerResolver: LedgerMessageResolver = {
  async resolveMessage(conversationId, ledgerSeq) {
    const entry = conv.getLedgerEntry(conversationId, ledgerSeq);
    if (!entry) return null;
    return entry.content as never;
  },
};
export const runPort: AgentRunPort = sqliteAgentRunAdapter(db, {
  contextPort: ctxPort,
  ledgerResolver,
  idGen,
});

export function freshFixture(prefix: string) {
  const conversationId = `conv-run-${prefix}`;
  const agentId = `ag-run-${prefix}`;
  conv.createConversation({
    conversationId,
    agentId,
    createdAt: Date.now(),
  });
  // Add a ledger message
  conv.appendLedgerEntry({
    conversationId,
    senderMemberId: agentId,
    kind: "message",
    content: JSON.stringify({ role: "user", text: `hello-${prefix}` }),
    ts: Date.now(),
  });
  return { conversationId, agentId };
}

export async function setupBranch(prefix: string) {
  const { conversationId, agentId } = freshFixture(prefix);
  const tree = await ctxPort.getOrCreateTree(conversationId);
  const branch = await ctxPort.getOrCreateDefaultBranch(tree.treeId, "oma");
  return { conversationId, agentId, branch };
}
