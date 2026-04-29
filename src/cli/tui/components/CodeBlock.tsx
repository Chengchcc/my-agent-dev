import { Box, Text } from 'ink';
import Prism from 'prismjs';
import React, { useMemo } from 'react';
import { prismTheme } from './utils/prism-theme';

const languageNames: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
};

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lang = language ? (languageNames[language] ?? language) : 'text';

  const tokens = useMemo(() => {
    if (lang === 'text' || !Prism.languages[lang]) {
      return [{ content: code }];
    }
    return tokenizeToInkTokens(code, Prism.languages[lang]);
  }, [code, lang]);

  return (
    <Box marginY={1} paddingLeft={1}>
      <Text>
        {tokens.map((token, index) => {
          const color = token.type ? (prismTheme[token.type] ?? 'white') : 'white';
          // Handle italic/bold styles
          if (color === 'italic') {
            return (
              <Text key={index} italic>
                {token.content}
              </Text>
            );
          }
          if (color === 'bold') {
            return (
              <Text key={index} bold>
                {token.content}
              </Text>
            );
          }
          return (
            <Text key={index} color={color}>
              {token.content}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}

// Recursively tokenize using Prism's tokenize API directly (no HTML needed!)
function tokenizeToInkTokens(code: string, grammar: Prism.Grammar): Array<{ content: string; type?: string }> {
  const tokens = Prism.tokenize(code, grammar);
  const result: Array<{ content: string; type?: string }> = [];

  for (const token of tokens) {
    if (typeof token === 'string') {
      result.push({ content: token });
    } else {
      // If token has nested tokens, recursively process them
      if (token.content && Array.isArray(token.content)) {
        const nested = processNestedToken(token);
        result.push(...nested);
      } else {
        result.push({
          content: typeof token.content === 'string' ? token.content : String(token.content),
          type: token.type,
        });
      }
    }
  }

  return result;
}

function processNestedToken(token: Prism.Token): Array<{ content: string; type?: string }> {
  const result: Array<{ content: string; type?: string }> = [];

  if (Array.isArray(token.content)) {
    for (const child of token.content) {
      if (typeof child === 'string') {
        result.push({ content: child, type: token.type });
      } else {
        // Nested token keeps parent type but allows child type to override
        if (child.content && Array.isArray(child.content)) {
          result.push(...processNestedToken(child));
        } else {
          result.push({
            content: typeof child.content === 'string' ? child.content : String(child.content),
            type: child.type ?? token.type,
          });
        }
      }
    }
  } else if (typeof token.content === 'string') {
    result.push({ content: token.content, type: token.type });
  }

  return result;
}
