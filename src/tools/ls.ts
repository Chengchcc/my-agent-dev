import { z } from 'zod';
import { readdirSync, statSync } from 'fs';
import { resolve, relative, join } from 'path';
import { allowedRoots } from '../config/allowed-roots';
import { ZodTool } from './zod-tool';
import { debugWarn } from '../utils/debug';

export class LsTool extends ZodTool {
  schema = z.object({
    path: z.string().default(process.cwd()).describe('Directory path to list'),
    depth: z.number().int().min(1).max(5).default(1).describe('Recursion depth'),
    include_hidden: z.boolean().default(false).describe('Include hidden files'),
    sort_by: z.enum(['name', 'size', 'modified']).default('name').describe('Sort order'),
  });

  name = 'ls';
  description = 'List directory contents with file metadata';

  protected handle(args: z.infer<typeof this.schema>) {
    const dirPath = resolve(args.path);

    // Validate path is within allowed roots
    if (!allowedRoots.some(root => dirPath.startsWith(root))) {
      throw new Error(`Path ${dirPath} is not within allowed directories`);
    }

    const stats = statSync(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`Path ${dirPath} is not a directory`);
    }

    const entries: Array<{
      name: string;
      path: string;
      type: 'file' | 'directory' | 'symlink';
      size?: number;
      modified?: string;
      children_count?: number;
    }> = [];

    const errors: string[] = [];

    const scanDirectory = (currentPath: string, currentDepth: number) => {
      if (currentDepth > args.depth) return;

      let dirEntries;
      try {
        dirEntries = readdirSync(currentPath, { withFileTypes: true });
      } catch (e) {
        const errorMsg = `Could not read directory ${currentPath}: ${(e as Error).message}`;
        errors.push(errorMsg);
        debugWarn(errorMsg);
        return;
      }

      for (const entry of dirEntries) {
        // Skip hidden files unless explicitly requested
        if (!args.include_hidden && entry.name.startsWith('.')) {
          continue;
        }

        const fullPath = join(currentPath, entry.name);
        const relativePath = relative(dirPath, fullPath);
        let entryStats;
        try {
          entryStats = statSync(fullPath);
        } catch (e) {
          const errorMsg = `Could not stat ${fullPath}: ${(e as Error).message}`;
          errors.push(errorMsg);
          debugWarn(errorMsg);
          continue;
        }

        const entryData: any = {
          name: entry.name,
          path: relativePath,
          size: entryStats.size,
          modified: entryStats.mtime.toISOString(),
        };

        if (entry.isDirectory()) {
          entryData.type = 'directory';
          if (currentDepth < args.depth) {
            try {
              const children = readdirSync(fullPath);
              entryData.children_count = children.length;
            } catch (e) {
              const errorMsg = `Could not read children of ${fullPath}: ${(e as Error).message}`;
              errors.push(errorMsg);
              debugWarn(errorMsg);
            }
          }
        } else if (entry.isFile()) {
          entryData.type = 'file';
        } else if (entry.isSymbolicLink()) {
          entryData.type = 'symlink';
        } else {
          continue;
        }

        entries.push(entryData);

        // Recursively scan subdirectories
        if (entry.isDirectory() && currentDepth < args.depth) {
          scanDirectory(fullPath, currentDepth + 1);
        }
      }
    };

    scanDirectory(dirPath, 1);

    // Sort entries
    switch (args.sort_by) {
      case 'name':
        entries.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'size':
        entries.sort((a, b) => (b.size || 0) - (a.size || 0));
        break;
      case 'modified':
        entries.sort((a, b) => {
          const aTime = a.modified ? new Date(a.modified).getTime() : 0;
          const bTime = b.modified ? new Date(b.modified).getTime() : 0;
          return bTime - aTime;
        });
        break;
    }

    // Separate directories and files
    const directories = entries.filter(e => e.type === 'directory');
    const files = entries.filter(e => e.type === 'file');
    const symlinks = entries.filter(e => e.type === 'symlink');

    // Sort groups: directories first, then files, then symlinks
    const sortedEntries = [...directories, ...files, ...symlinks];

    return {
      entries: sortedEntries,
      path: dirPath,
      total_entries: sortedEntries.length,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}
