import type * as schema from "../../infra/db/schema.js";

// ─── Types derived from drizzle table $inferSelect/$inferInsert ───
// drizzle tables are the Typescript truth source.
// drizzle-zod schemas provide RUNTIME validation (JSON.parse transforms, .safeParse).
// drizzle-zod's BuildSchema<> isn't ZodType, so z.infer<> is incompatible — $inferSelect is.

export type SurfaceHealthRow = Omit<typeof schema.surfaceHealth.$inferSelect, "payload"> & {
  payload: Record<string, unknown>;
};
