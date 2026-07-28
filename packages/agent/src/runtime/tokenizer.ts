/** Token estimation utility.
 *  Default: 4 bytes/token approximation (fast, no dependency).
 *  Set PI_TOKENIZER_ACCURATE=1 for native tokenizer if available. */

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf-8") / CHARS_PER_TOKEN);
}

export function countTokens(text: string | string[]): number {
  if (Array.isArray(text)) {
    return text.reduce((sum, t) => sum + estimateTokens(t), 0);
  }
  return estimateTokens(text);
}

export function countMessageTokens(messages: readonly unknown[]): number {
  return countTokens(JSON.stringify(messages));
}
