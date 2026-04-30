const DJB2_INITIAL_HASH = 5381;

/** Simple DJB2 hash for content-based versioning (memory preferences, skill catalog). */
export function djb2Hash(text: string): string {
  let hash = DJB2_INITIAL_HASH;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}
