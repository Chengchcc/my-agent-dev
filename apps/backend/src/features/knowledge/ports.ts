import type { KnowledgePackRow } from "./entities.js";

export interface KnowledgePackPort {
  create(row: KnowledgePackRow): KnowledgePackRow;
  list(): KnowledgePackRow[];
  getById(id: string): KnowledgePackRow | null;
  update(id: string, patch: Partial<KnowledgePackRow>): KnowledgePackRow | null;
  delete(id: string): boolean;
}
