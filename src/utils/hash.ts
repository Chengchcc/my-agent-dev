const DJB2_INITIAL_HASH = 5381;
const DJB2_SHIFT = 5;
const HEX_RADIX = 16;

/** Simple DJB2 hash for content-based versioning (memory preferences, skill catalog). */
export function djb2Hash(text: string): string {
  let hash = DJB2_INITIAL_HASH;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << DJB2_SHIFT) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(HEX_RADIX);
}
