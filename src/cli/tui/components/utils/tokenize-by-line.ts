import type { Token } from 'prismjs';

export interface LineToken {
  content: string;
  type?: string;
  styles?: string[];
}

export function tokenizeByLine(tokens: Array<Token | string>, lineLengths: number[]): LineToken[][] {
  const lines: LineToken[][] = [];
  let currentLine = 0;
  let currentLineLength = 0;

  let currentLineTokens: LineToken[] = [];

  for (const token of tokens) {
    if (typeof token === 'string') {
      // Split string into lines
      const linesInToken = token.split('\n');

      for (let i = 0; i < linesInToken.length; i++) {
        const linePart = linesInToken[i];

        if (i > 0) {
          // End of previous line
          lines.push(currentLineTokens);
          currentLine++;
          currentLineLength = 0;
          currentLineTokens = [];
        }

        if (linePart.length > 0) {
          currentLineTokens.push({
            content: linePart,
          });
          currentLineLength += linePart.length;
        }
      }
    } else {
      // Handle Prism Token objects
      if (token.content && Array.isArray(token.content)) {
        // Recursively process nested tokens
        const nestedTokens = tokenizeByLine(token.content, lineLengths);
        for (const nestedLine of nestedTokens) {
          for (const nestedToken of nestedLine) {
            currentLineTokens.push({
              ...nestedToken,
              type: token.type,
            });
          }
        }
      } else {
        const content = typeof token.content === 'string' ? token.content : String(token.content);
        currentLineTokens.push({
          content,
          type: token.type,
        });
      }
    }
  }

  // Add the last line
  if (currentLineTokens.length > 0) {
    lines.push(currentLineTokens);
  }

  return lines;
}
