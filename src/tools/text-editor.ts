import fs from 'fs/promises';
import path from 'path';
import { ZodTool } from './zod-tool';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { z } from 'zod';

/**
 * Built-in text editor tool similar to Anthropic Claude Platform.
 * Supports: view, create, str_replace, write operations.
 */
export class TextEditorTool extends ZodTool<z.ZodObject<{
  command: z.ZodEnum<['view', 'create', 'str_replace', 'write']>;
  path: z.ZodString;
  old_string: z.ZodOptional<z.ZodString>;
  new_string: z.ZodOptional<z.ZodString>;
  content: z.ZodOptional<z.ZodString>;
  start_line: z.ZodOptional<z.ZodNumber>;
  end_line: z.ZodOptional<z.ZodNumber>;
}>> {
  protected readonly name = 'text_editor';
  protected readonly description = 'Read, create, edit, and write text files. Supports: view (display file content), create (create new file), str_replace (replace specific string), write (write entire file). DO NOT batch with other text_editor calls on the same file; emit sequentially.';
  readonly = false;
  conflictKey = (input: unknown) => `file:${(input as Record<string, unknown>).path ?? 'unknown'}`;

  protected schema = z.object({
    command: z.enum(['view', 'create', 'str_replace', 'write']),
    path: z.string(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
    content: z.string().optional(),
    start_line: z.number().optional(),
    end_line: z.number().optional(),
  });

  private allowedRoots: string[];

  constructor(allowedRoots: string[] = []) {
    super();
    this.allowedRoots = allowedRoots;
  }

  /**
   * Validate path against allowed roots.
   */
  private validatePath(filePath: string): boolean {
    if (!this.allowedRoots || this.allowedRoots.length === 0) {
      return true;
    }
    const resolved = path.resolve(filePath);
    return this.allowedRoots.some(root => {
      const resolvedAllowed = path.resolve(root);
      return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + path.sep);
    });
  }

  /**
   * Execute the text editor command.
   */
  protected async handle(params: z.infer<typeof this.schema>, _ctx: ToolContext): Promise<{ result: string } | { error: string }> {
    const { command, path: filePath } = params;

    if (!this.validatePath(filePath)) {
      return { error: `Error: Path "${filePath}" is not allowed.` };
    }

    try {
      switch (command) {
        case 'view': {
          return await this.view(filePath, params.start_line, params.end_line);
        }
        case 'create': {
          if (!params.content) {
            return { error: 'Error: content is required for create command.' };
          }
          return await this.create(filePath, params.content);
        }
        case 'str_replace': {
          if (!params.old_string) {
            return { error: 'Error: old_string is required for str_replace command.' };
          }
          if (params.new_string === undefined) {
            return { error: 'Error: new_string is required for str_replace command.' };
          }
          return await this.strReplace(filePath, params.old_string, params.new_string);
        }
        case 'write': {
          if (!params.content) {
            return { error: 'Error: content is required for write command.' };
          }
          return await this.write(filePath, params.content);
        }
        default:
          return { error: `Error: unknown command "${command}".` };
      }
    } catch (e) {
      return { error: `Error: ${(e as Error).message}` };
    }
  }

  /**
   * View file content with optional line range.
   */
  private async view(filePath: string, startLine?: number, endLine?: number): Promise<{ result: string } | { error: string }> {
    let content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    if (startLine !== undefined) {
      // Convert to 0-indexed
      const start = Math.max(0, startLine - 1);
      const end = endLine !== undefined ? endLine : lines.length;
      const selected = lines.slice(start, end);
      content = selected.join('\n');
      // Add line numbers
      const LINE_NUMBER_PAD_WIDTH = 6;
      const numbered = selected.map((line, i) => `${String(start + i + 1).padStart(LINE_NUMBER_PAD_WIDTH, ' ')} ${line}`);
      return { result: numbered.join('\n') };
    }

    return { result: content };
  }

  /**
   * Create a new file with content. Errors if file already exists.
   */
  private async create(filePath: string, content: string): Promise<{ result: string } | { error: string }> {
    try {
      await fs.access(filePath);
      return { error: `Error: File already exists at ${filePath}. Use str_replace or write to modify it.` };
    } catch {
      // File doesn't exist, good - create parent directories if needed
      const dirPath = path.dirname(filePath);
      await fs.mkdir(dirPath, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return { result: `Created file ${filePath} successfully.` };
    }
  }

  /**
   * Replace exact string in a file. Fails if old_string doesn't match exactly.
   */
  private async strReplace(filePath: string, oldString: string, newString: string): Promise<{ result: string } | { error: string }> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (_e) {
      return { error: `Error: File ${filePath} does not exist.` };
    }

    if (!content.includes(oldString)) {
      return { error: `Error: old_string not found exactly once in file. Search failed.` };
    }

    // Count occurrences using string search (more reliable than regex for exact matching)
    let count = 0;
    let pos = 0;
    while ((pos = content.indexOf(oldString, pos)) !== -1) {
      count++;
      pos += oldString.length;
    }

    if (count > 1) {
      return { error: `Error: old_string found ${count} times in file. Please be more specific.` };
    }

    const newContent = content.replace(oldString, newString);
    await fs.writeFile(filePath, newContent, 'utf-8');
    return { result: `Replaced ${count} occurrence in ${filePath} successfully.` };
  }

  /**
   * Write entire file, overwrites if exists, creates if doesn't exist.
   */
  private async write(filePath: string, content: string): Promise<{ result: string } | { error: string }> {
    // Create parent directories if needed
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return { result: `Wrote ${filePath} successfully.` };
  }
}
