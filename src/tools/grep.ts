import { z } from 'zod';
import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, extname, join } from 'path';
import { allowedRoots } from '../config/allowed-roots';
import { ZodTool } from './zod-tool';
import { getLanguageFromFilePath } from '../cli/tui/components/utils/language-map';

const DEFAULT_EXCLUDE_PATTERNS = ['node_modules', '.git', 'dist', 'build', '.DS_Store'];

export class GrepTool extends ZodTool {
  schema = z.object({
    pattern: z.string().describe('Text or regex pattern to search for'),
    path: z.string().default(process.cwd()).describe('Base directory to search from'),
    include: z.string().optional().describe('Glob filter for file names (e.g., *.ts, *.{ts,tsx})'),
    exclude: z.array(z.string()).default(DEFAULT_EXCLUDE_PATTERNS).describe('Patterns to exclude'),
    max_results: z.number().int().positive().default(100).describe('Maximum matching lines to return'),
    case_sensitive: z.boolean().default(false).describe('Case sensitive search'),
    is_regex: z.boolean().default(false).describe('Is pattern a regular expression'),
    context_lines: z.number().int().nonnegative().default(0).describe('Context lines before/after each match'),
  });

  name = 'grep';
  description = 'Search file content for text/regex patterns';

  protected handle(args: z.infer<typeof this.schema>) {
    const searchPath = resolve(args.path);

    // Validate path is within allowed roots
    if (!allowedRoots.some(root => searchPath.startsWith(root))) {
      throw new Error(`Path ${searchPath} is not within allowed directories`);
    }

    const stats = statSync(searchPath);
    if (!stats.isDirectory()) {
      throw new Error(`Path ${searchPath} is not a directory`);
    }

    let regex: RegExp;
    try {
      if (args.is_regex) {
        regex = new RegExp(args.pattern, args.case_sensitive ? 'g' : 'gi');
      } else {
        const escapedPattern = args.pattern.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&');
        regex = new RegExp(escapedPattern, args.case_sensitive ? 'g' : 'gi');
      }
    } catch (e) {
      throw new Error(`Invalid regular expression: ${(e as Error).message}`);
    }

    const matches: Array<{
      file: string;
      line: number;
      content: string;
      context?: {
        before: string[];
        after: string[];
      };
    }> = [];

    let filesSearched = 0;

    // Walk directory
    const walkDir = (dir: string) => {
      if (matches.length >= args.max_results) return;

      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (matches.length >= args.max_results) break;

        const fullPath = join(dir, entry.name);

        // Check if excluded
        if (args.exclude.some(pattern => entry.name.match(pattern))) {
          continue;
        }

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          // Check include pattern
          if (args.include && !entry.name.match(args.include)) {
            continue;
          }

          // Skip binary files
          if (!isTextFile(fullPath)) {
            continue;
          }

          try {
            const content = readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            filesSearched++;

            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
              if (matches.length >= args.max_results) break;

              const line = lines[lineIndex];
              if (regex.test(line)) {
                const match: any = {
                  file: fullPath,
                  line: lineIndex + 1,
                  content: line.trim(),
                };

                // Add context if requested
                if (args.context_lines > 0) {
                  const before = lines.slice(
                    Math.max(0, lineIndex - args.context_lines),
                    lineIndex
                  );
                  const after = lines.slice(
                    lineIndex + 1,
                    Math.min(lines.length, lineIndex + args.context_lines + 1)
                  );
                  match.context = { before, after };
                }

                matches.push(match);
                regex.lastIndex = 0; // Reset regex for next test
              }
            }
          } catch (e) {
            // Skip files that can't be read
            console.warn(`Could not read file ${fullPath}:`, (e as Error).message);
          }
        }
      }
    };

    walkDir(searchPath);

    return {
      matches,
      truncated: matches.length >= args.max_results,
      total_matches: matches.length,
      files_searched: filesSearched,
    };
  }
}

function isTextFile(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    if (stats.size < 1024) return true;

    const ext = extname(filePath).toLowerCase();
    const textExtensions = new Set([
      '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.scss',
      '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.php', '.java', '.c', '.cpp',
      '.h', '.hpp', '.go', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh',
      '.sql', '.graphql', '.prisma', '.mdx', '.markdown', '.rst', '.tex', '.bib',
    ]);

    if (textExtensions.has(ext)) return true;

    // Check for null bytes
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
  } catch {
    return false;
  }
}
