import { createInMemorySessionStore } from "./in-memory-session-store.js";
import { runSessionStoreContract } from "./session-store.contract.js";

runSessionStoreContract("InMemory", async () => createInMemorySessionStore());
