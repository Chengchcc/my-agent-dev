// migrate-legacy.ts
// Usage: bun run apps/backend/src/features/loop/migrate-legacy.ts <loopsDir> <backendDbPath>
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseInboxMd, parseStateMd } from "./loop-core.js";
import { createLoopStateStore } from "./loop-state-store.js";

const loopsDir = process.argv[2];
const dbPath = process.argv[3];

if (!loopsDir || !dbPath) {
  console.error("Usage: bun run migrate-legacy.ts <loopsDir> <backendDbPath>");
  process.exit(1);
}

const db = new Database(dbPath);
const store = createLoopStateStore(db);

for (const entry of readdirSync(loopsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const loopId = entry.name;
  const dir = join(loopsDir, loopId);

  let stateMd = "",
    inboxMd = "";
  try {
    stateMd = await Bun.file(join(dir, "STATE.md")).text();
  } catch {
    /* no state */
  }
  try {
    inboxMd = await Bun.file(join(dir, "INBOX.md")).text();
  } catch {
    /* no inbox */
  }

  const state = parseStateMd(stateMd);
  const inboxItems = parseInboxMd(inboxMd);

  store.save(loopId, state, inboxItems);
  console.log(
    `Migrated loop "${loopId}": ${Object.keys(state.items).length} active, ${Object.keys(inboxItems).length} inbox`,
  );
}

console.log("Migration complete.");
