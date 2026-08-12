/** Coding Agent product public API: the single Runtime factory plus the
 *  pieces the modes are built from. Everything else (CLI entry, RPC/JSON/
 *  print modes) is app-internal. */

export { type CliArgs, type CliMode, parseArgs, UsageError } from "./cli/args.js";
export { buildCliRunInput } from "./cli/initial-input.js";
export {
  type CodingAgentRuntime,
  type CreateCodingAgentRuntimeOptions,
  createCodingAgentRuntime,
} from "./core/create-runtime.js";
export { buildBackendModelCatalog, type ModelCatalogOptions } from "./core/model-catalog.js";
export {
  adaptProductTool,
  buildProductTools,
  type ProductToolCaller,
  type ProductToolCallIdentity,
  type ProductToolTransportOptions,
} from "./core/product-tool-transport.js";
export {
  assembleRunRuntime,
  type RunRuntime,
  type RunRuntimeDeps,
  registerBuiltinProviders,
} from "./core/run-runtime.js";
export { registerProvidersFromCatalog } from "./core/runtime-catalog.js";
export { runJsonMode } from "./modes/json-mode.js";
export { assistantText, type CliRunOptions, runPrintMode } from "./modes/print-mode.js";
export { createJsonlReader, type JsonlReaderOptions } from "./modes/rpc/jsonl.js";
export { type RpcModeController, type RpcModeOptions, runRpcMode } from "./modes/rpc/rpc-mode.js";
