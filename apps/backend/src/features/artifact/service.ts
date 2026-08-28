import {
  type ArtifactContent,
  type ArtifactMeta,
  type ArtifactRef,
  type ArtifactUploadInput,
  artifactUrl,
  parseArtifactUrl,
  splitPath,
} from "./domain.js";
import type { ArtifactPort } from "./ports.js";

export interface ArtifactService {
  upload(input: ArtifactUploadInput): Promise<ArtifactMeta>;
  download(url: string): Promise<ArtifactContent>;
  list(folder?: string): Promise<ArtifactMeta[]>;
  delete(url: string): Promise<boolean>;
  exists(url: string): Promise<boolean>;
}

export function createArtifactService(port: ArtifactPort): ArtifactService {
  return {
    async upload(input) {
      const [folder, filename] = splitPath(`${input.folder}/${input.filename}`);
      const ref: ArtifactRef = { folder, filename };
      return port.put({ ...input, folder: ref.folder, filename: ref.filename });
    },
    async download(url) {
      const ref = parseArtifactUrl(url);
      const rec = await port.get(ref);
      if (!rec) throw new Error(`artifact not found: ${url}`);
      return {
        content: rec.content,
        encoding: rec.encoding,
        mimeType: rec.mimeType,
        size: rec.size,
      };
    },
    async list(folder) {
      return port.list(folder);
    },
    async delete(url) {
      return port.delete(url);
    },
    async exists(url) {
      return port.exists(url);
    },
  };
}

export { artifactUrl };
