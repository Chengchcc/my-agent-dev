import type { AgentExtensionFactory } from "@my-agent-team/agent";
import type { Capability, CapabilityManifest, CapabilityServerContext } from "./types.js";

function withId(id: string, ext: { id?: string }): { id: string } {
  const { id: _, ...rest } = ext;
  return { id, ...rest };
}

export class CapabilityRegistry {
  readonly #caps = new Map<string, Capability>();
  readonly #order: string[] = [];

  register(cap: Capability): void {
    if (this.#caps.has(cap.id)) throw new Error(`Duplicate capability: ${cap.id}`);
    this.#caps.set(cap.id, cap);
    this.#order.push(cap.id);
  }

  list(): readonly Capability[] {
    return this.#order.map((id) => this.#caps.get(id)!);
  }

  extensionFactories(): readonly AgentExtensionFactory[] {
    return this.#order.map((id) => {
      const cap = this.#caps.get(id)!;
      return {
        id,
        create: async (scope) => withId(id, (await cap.extendAgent?.(scope)) ?? { id }),
      };
    });
  }

  async installServer(ctx: CapabilityServerContext): Promise<void> {
    for (const id of this.#order) await this.#caps.get(id)!.installServer?.(ctx);
  }

  getManifests(): CapabilityManifest[] {
    return this.#order.map((id) => this.#caps.get(id)!.manifest ?? { id });
  }
}
