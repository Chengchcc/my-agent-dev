import type { ArtifactMeta, ArtifactRef, ArtifactUploadInput } from "./domain.js";

export interface ArtifactPort {
  put(input: ArtifactUploadInput): Promise<ArtifactMeta>;
  get(ref: ArtifactRef): Promise<(ArtifactMeta & { content: string }) | null>;
  list(folder?: string): Promise<ArtifactMeta[]>;
  delete(url: string): Promise<boolean>;
  exists(url: string): Promise<boolean>;
}
