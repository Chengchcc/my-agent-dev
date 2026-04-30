import { z } from 'zod';
import fastGlob from 'fast-glob';
import { resolve } from 'path';
import { allowedRoots } from '../config/allowed-roots';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { ZodTool } from './zod-tool';

const DEFAULT_EXCLUDE_PATTERNS = ['node_modules', '.git', 'dist', 'build', '.DS_Store', '*.env', '*.key', '*credential*'];

const DEFAULT_GLOB_MAX_RESULTS = 200;
const DEFAULT_GLOB_MAX_DEPTH = 30;

export class GlobTool extends ZodTool {
  schema = z.object({
    pattern: z.string().describe('Glob pattern (e.g., src/**/*.ts, **/package.json)'),
    path: z.string().default(process.cwd()).describe('Base directory to search from'),
    exclude: z.array(z.string()).default(DEFAULT_EXCLUDE_PATTERNS).describe('Patterns to exclude'),
    max_results: z.number().int().positive().default(DEFAULT_GLOB_MAX_RESULTS).describe('Maximum results to return'),
    deep: z.number().int().positive().default(DEFAULT_GLOB_MAX_DEPTH).describe('Maximum directory depth to search'),
    include_hidden: z.boolean().default(false).describe('Include hidden files (starting with .)'),
  });

  readonly = true;
  name = 'glob';
  description = 'Find files by glob pattern. SAFE TO CALL IN PARALLEL with other read-only tools in the same response.';

  protected handle(args: z.infer<typeof this.schema>, _ctx: ToolContext) {
    const searchPath = resolve(args.path);

    // Validate path is within allowed roots
    if (!allowedRoots.some(root => searchPath.startsWith(root))) {
      throw new Error(`Path ${searchPath} is not within allowed directories`);
    }

    const patterns = [args.pattern];
    const options = {
      cwd: searchPath,
      ignore: args.exclude,
      dot: args.include_hidden,
      absolute: true,
      deep: args.deep,
      suppressErrors: true,
    };

    const files = fastGlob.sync(patterns, options);

    // Filter results to be within allowed roots
    const filteredFiles = files.filter(file =>
      allowedRoots.some(root => file.startsWith(root))
    );

    // Apply max results limit
    const truncatedFiles = filteredFiles.slice(0, args.max_results);
    const truncated = filteredFiles.length > args.max_results;

    return {
      files: truncatedFiles,
      truncated,
      total_matched: filteredFiles.length,
    };
  }
}
