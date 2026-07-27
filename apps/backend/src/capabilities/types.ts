
import type { AgentExtension } from "@my-agent-team/agent";
import type { ChatModel } from "@my-agent-team/core";
// Re-export for backend consumers
export type { AgentExtension };

export interface CapabilityManifest {
  id: string;
  slots?: readonly string[];
}

export interface AgentScope {
  agentId: string;
  sessionId: string;
  conversationId?: string;
  memberId?: string;
  cwd: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type TypedRoute = {};

export type CommandHandler = (input: string) => string | Promise<string>;

export interface CapabilityServerContext {
  registerRoute(route: TypedRoute): void;
  registerCommand(name: string, handler: CommandHandler): void;
}

export interface Capability {
  readonly id: string;
  extendAgent?(scope: AgentScope): AgentExtension | Promise<AgentExtension>;
  installServer?(ctx: CapabilityServerContext): void | Promise<void>;
  readonly manifest?: CapabilityManifest;
}

// ── Backend infrastructure ──

export interface BackendInfrastructure {
  modelRegistry: { get(name: string): ChatModel };
  settings: {
    get(key: string): string | undefined;
    getNumber(key: string): Promise<number | undefined>;
    set(key: string, value: string | number): void | Promise<void>;
  };
  fs: { cwd: string; read(path: string): string; write(path: string, content: string): void };
  sse: { emit(event: string, data: unknown): void };
}

// ── Capability-specific deps ──

export interface MemoryCapabilityDeps {
  modelRegistry: BackendInfrastructure["modelRegistry"];
  settings: BackendInfrastructure["settings"];
  fs: BackendInfrastructure["fs"];
}

export interface PetCapabilityDeps {
  modelRegistry: BackendInfrastructure["modelRegistry"];
  settings: BackendInfrastructure["settings"];
  fs: BackendInfrastructure["fs"];
}

export interface RecapCapabilityDeps {
  modelRegistry: BackendInfrastructure["modelRegistry"];
}

export interface IdentityCapabilityDeps {
  fs: BackendInfrastructure["fs"];
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type ConversationContextDeps = {};

export interface MemoryReader {
  search(
    query: string,
    scope: { agentId: string },
  ): Promise<readonly { content: string; score: number }[]>;
}
