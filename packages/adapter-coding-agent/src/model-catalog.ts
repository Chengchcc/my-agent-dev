import type { BackendModelCatalog } from "@my-agent-team/agent-backend";
import type { CodingAgentClient } from "./client.js";

/** Thin model catalog adapter over the daemon's /v1/models. Independent of the
 *  AgentBackend method set (which has no model-listing method). */
export class CodingAgentModelCatalog {
  private readonly client: CodingAgentClient;

  constructor(client: CodingAgentClient) {
    this.client = client;
  }

  async list(): Promise<BackendModelCatalog> {
    const resp = await this.client.getModels();
    return {
      backendKind: resp.backendKind,
      models: resp.models,
    };
  }
}
