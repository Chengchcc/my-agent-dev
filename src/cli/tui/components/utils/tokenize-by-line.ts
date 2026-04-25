import type { Token } from 'prismjs';

export interface LineToken {
  content: string;
  type: string | null;
}

export function tokenizeByLine(tokens: Array<Token | string>): LineToken[][] {
  const lines: LineToken[][] = [];
  let currentLineTokens: LineToken[] = [];

  for (const token of tokens) {
    if (typeof token === 'string') {
      // Split string into lines
      const linesInToken = token.split('\n');

      for (let i = 0; i < linesInToken.length; i++) {
        const linePart = linesInToken[i] ?? '';

        if (i > 0) {
          // End of previous line
          lines.push(currentLineTokens);
          currentLineTokens = [];
        }

        if (linePart.length > 0) {
          currentLineTokens.push({
            content: linePart,
            type: null,
          });
        }
      }
    } else {
      // Handle Prism Token objects
      if (token.content && Array.isArray(token.content)) {
        // Recursively process nested tokens
        const nestedLines = tokenizeByLine(token.content);

        // First nested line continues on the current line
        if (nestedLines.length > 0) {
          // Add first line to current line
          const firstLine = nestedLines[0];
          if (firstLine) {
            for (const nestedToken of firstLine) {
              currentLineTokens.push({
                ...nestedToken,
                // Keep nested token type unless it didn't have one, then use parent's
                type: nestedToken.type ?? token.type,
              });
            }
          }

          // Any additional nested lines become new lines in our output
          for (let i = 1; i < nestedLines.length; i++) {
            lines.push(currentLineTokens);
            currentLineTokens = [];
            // Add the nested line's tokens to the new current line
            const line = nestedLines[i];
            if (line) {
              for (const nestedToken of line) {
                currentLineTokens.push({
                  ...nestedToken,
                  type: nestedToken.type ?? token.type,
                });
              }
            }
          }
        }
      } else {
        const content = typeof token.content === 'string' ? token.content : String(token.content);
        // Split string content into lines even when inside a Prism Token
        const linesInToken = content.split('\n');
        for (let i = 0; i < linesInToken.length; i++) {
          const linePart = linesInToken[i] ?? '';
          if (i > 0) {
            // End of previous line
            lines.push(currentLineTokens);
            currentLineTokens = [];
          }
          if (linePart.length > 0) {
            currentLineTokens.push({
              content: linePart,
              type: token.type,
            });
          }
        }
      }
    }
  }

  // Add the last line
  if (currentLineTokens.length > 0) {
    lines.push(currentLineTokens);
  }

  return lines;
}
