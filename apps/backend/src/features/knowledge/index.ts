export { sqliteKnowledgePackAdapter } from "./adapter-sqlite.js";
export type { KnowledgePackRow, KnowledgePackSource, KnowledgePackStatus } from "./entities.js";
export { knowledgeRoutes } from "./http.js";
export { knowledgeInstallRoot, knowledgePackIndex } from "./install.js";
export type { KnowledgePackPort } from "./ports.js";
export {
  createKnowledgeService,
  KnowledgePackNotFoundError,
  type KnowledgeService,
  KnowledgeValidationError,
} from "./service.js";
