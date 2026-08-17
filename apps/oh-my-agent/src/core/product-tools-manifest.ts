import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** The cwd product-tool manifest contract (ADR 0003 decision 6): the
 *  workspace bridge writes `.oma/product-tools.json`; the child reads it
 *  here and builds its tool table from workspace files, not the run input.
 *  The zod parse is the honest wire→domain boundary. */
export interface ProductToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly entrypoint: string;
}

const descriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  entrypoint: z.string(),
});

export function readProductToolsManifest(workspaceRoot: string): readonly ProductToolDescriptor[] {
  const path = join(workspaceRoot, ".oma", "product-tools.json");
  if (!existsSync(path)) return [];
  try {
    return z.array(descriptorSchema).parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // Corrupt/malformed manifest degrades to no product tools (same as absent).
    return [];
  }
}
