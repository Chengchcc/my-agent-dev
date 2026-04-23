import { statSync, openSync, readSync, closeSync } from 'fs';
import { extname } from 'path';

const textExtensions = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.scss',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.php', '.java', '.c', '.cpp',
  '.h', '.hpp', '.go', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.prisma', '.mdx', '.markdown', '.rst', '.tex', '.bib',
]);

/**
 * Check if a file is likely a text file based on extension and content inspection
 * @param filePath Full path to the file
 * @returns True if file appears to be a text file
 */
export function isTextFile(filePath: string): boolean {
  try {
    const stats = statSync(filePath);

    // Small files are likely text
    if (stats.size < 1024) return true;

    const ext = extname(filePath).toLowerCase();
    if (textExtensions.has(ext)) return true;

    // For unknown extensions, check first 1024 bytes for null bytes
    const buffer = Buffer.alloc(1024);
    const fd = openSync(filePath, 'r');
    try {
      const bytesRead = readSync(fd, buffer, 0, 1024, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return false;
      }
      return true;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
