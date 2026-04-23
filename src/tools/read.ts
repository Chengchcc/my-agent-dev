import { z } from 'zod';
import { readFileSync, statSync } from 'fs';
import { resolve, extname } from 'path';
import { allowedRoots } from '../config/allowed-roots';
import { ZodTool } from './zod-tool';
import { getLanguageFromFilePath } from '../cli/tui/components/utils/language-map';
import { isTextFile } from '../utils/is-text-file';

export class ReadTool extends ZodTool {
  schema = z.object({
    path: z.string().describe('File path to read'),
    start_line: z.number().int().positive().default(1).describe('Starting line number (1-indexed)'),
    end_line: z.number().int().positive().optional().describe('Ending line number (inclusive)'),
    max_lines: z.number().int().positive().default(500).describe('Maximum lines to return'),
    encoding: z.enum(['utf8', 'ascii', 'utf16le', 'ucs2', 'base64', 'latin1', 'binary', 'hex']).default('utf8').describe('File encoding'),
  });

  name = 'read';
  description = 'Read file content with optional line range support';

  protected handle(args: z.infer<typeof this.schema>) {
    const resolvedPath = resolve(args.path);

    // Validate path is within allowed roots
    if (!allowedRoots.some(root => resolvedPath.startsWith(root))) {
      throw new Error(`File path ${resolvedPath} is not within allowed directories`);
    }

    // Check file exists and get stats
    let stats;
    try {
      stats = statSync(resolvedPath);
    } catch (e) {
      throw new Error(`Could not access file ${resolvedPath}: ${(e as Error).message}`);
    }

    if (stats.isDirectory()) {
      throw new Error(`Path ${resolvedPath} is a directory, use ls instead`);
    }

    // Check if this is a text file before reading
    if (!isTextFile(resolvedPath)) {
      throw new Error(`Path ${resolvedPath} appears to be a binary file, cannot read`);
    }

    const content = readFileSync(resolvedPath, { encoding: args.encoding });
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
