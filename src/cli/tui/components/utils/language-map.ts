export const extensionToLanguage: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.rb': 'ruby',
  '.php': 'php',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.json': 'json',
  '.md': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.go': 'go',
  '.rs': 'rust',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.prisma': 'prisma',
  '.xml': 'xml',
  '.svg': 'svg',
};

export function getLanguageFromFilePath(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return extensionToLanguage[ext.toLowerCase()];
}

export const inferLanguage = getLanguageFromFilePath;
