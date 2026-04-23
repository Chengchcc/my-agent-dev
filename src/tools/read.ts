import { z } from 'zod';
import { readFileSync, statSync } from 'fs';
import { resolve, extname } from 'path';
import { allowedRoots } from '../config/allowed-roots';
import { ZodTool } from './zod-tool';
import { getLanguageFromFilePath } from '../cli/tui/components/utils/language-map';

export class ReadTool extends ZodTool {
  schema = z.object({
    path: z.string().describe('File path to read'),
    start_line: z.number().int().positive().default(1).describe('Starting line number (1-indexed)'),
    end_line: z.number().int().positive().optional().describe('Ending line number (inclusive)'),
    max_lines: z.number().int().positive().default(500).describe('Maximum lines to return'),
    encoding: z.string().default('utf8').describe('File encoding'),
  });

  name = 'read';
  description = 'Read file content with optional line range support';

  protected handle(args: z.infer<typeof this.schema>) {
    const resolvedPath = resolve(args.path);

    // Validate path is within allowed roots
    if (!allowedRoots.some(root => resolvedPath.startsWith(root))) {
      throw new Error(`File path ${resolvedPath} is not within allowed directories`);
    }

    // Quick check if it's a directory first
    try {
      if (statSync(resolvedPath).isDirectory()) {
        throw new Error(`Path ${resolvedPath} is a directory, use ls instead`);
      }
    } catch (e) {
      throw new Error(`Could not access file ${resolvedPath}: ${(e as Error).message}`);
    }

    const content = readFileSync(resolvedPath, { encoding: args.encoding as BufferEncoding });
    const lines = content.split('\n');
    const totalLines = lines.length;

    let start = args.start_line - 1;
    let end = args.end_line ? args.end_line - 1 : totalLines - 1;

    // Clamp values
    start = Math.max(0, Math.min(start, totalLines - 1));
    end = Math.max(start, Math.min(end, totalLines - 1));

    // Apply max_lines limit
    if (args.max_lines > 0) {
      const requestedLines = end - start + 1;
      if (requestedLines > args.max_lines) {
        end = start + args.max_lines - 1;
      }
    }

    const selectedLines = lines.slice(start, end + 1);
    const truncated = end - start + 1 < (args.end_line ? args.end_line - args.start_line + 1 : totalLines - start);

    // Get stats again for size information - this is safe since we already checked the file exists
    const stats: any = statSync(resolvedPath);

    return {
      path: resolvedPath,
      content: selectedLines.join('\n'),
      total_lines: totalLines,
      range: {
        start: start + 1,
        end: end + 1,
      },
      truncated,
      size_bytes: stats.size,
      language: getLanguageFromFilePath(resolvedPath) || extname(resolvedPath).slice(1) || 'text',
    };
  }
}

function isTextFile(filePath: string, stats: ReturnType<typeof statSync>): boolean {
  // Small files are likely text
  if (stats!.size < 1024) return true;

  const ext = extname(filePath).toLowerCase();
  const textExtensions = new Set([
    '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.scss',
    '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.php', '.java', '.c', '.cpp',
    '.h', '.hpp', '.go', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh',
    '.sql', '.graphql', '.prisma', '.mdx', '.markdown', '.rst', '.tex', '.bib',
  ]);

  if (textExtensions.has(ext)) return true;

  // For unknown extensions, check first 1024 bytes for null bytes
  const buffer = Buffer.alloc(1024);
  const fd = require('fs').openSync(filePath, 'r');
  try {
    const bytesRead = require('fs').readSync(fd, buffer, 0, 1024, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return false;
    }
    return true;
  } finally {
    require('fs').closeSync(fd);
  }
}
