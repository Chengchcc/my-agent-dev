import fs from 'fs/promises';
import path from 'path';
import type { Tool } from '../types';
import type { ToolImplementation } from '../types';

/**
 * Supported commands for text editor.
 */
type TextEditorCommand = 'view' | 'create' | 'str_replace' | 'write';

/**
 * Built-in text editor tool similar to Anthropic Claude Platform.
 * Supports: view, create, str_replace, write operations.
 */
export class TextEditorTool implements ToolImplementation {
  private allowedRoots?: string[];

  constructor(options: { allowedRoots?: string[] } = {}) {
    this.allowedRoots = options.allowedRoots;
  }

  /**
   * Get the tool definition for function calling.
   */
  getDefinition(): Tool {
    return {
      name: 'text_editor',
      description: 'Read, create, edit, and write text files. Supports: view (display file content), create (create new file), str_replace (replace specific string), write (write entire file).',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['view', 'create', 'str_replace', 'write'],
            description: 'The command to execute.',
          },
          path: {
            type: 'string',
            description: 'The absolute path to the file.',
          },
          old_string: {
            type: 'string',
            description: 'The string to replace (required for str_replace).',
          },
          new_string: {
            type: 'string',
            description: 'The new string to replace with (required for str_replace).',
          },
          content: {
            type: 'string',
            description: 'Content for create or write command.',
          },
          start_line: {
            type: 'number',
            description: 'Starting line number for view (optional, 1-indexed).',
          },
          end_line: {
            type: 'number',
            description: 'Ending line number for view (optional, 1-indexed, inclusive).',
          },
        },
        required: ['command', 'path'],
      },
    };
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
  async execute(params: {
    command: TextEditorCommand;
    path: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    start_line?: number;
    end_line?: number;
  }): Promise<{ result: string } | { error: string }> {
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
      const numbered = selected.map((line, i) => `${String(start + i + 1).padStart(6, ' ')} ${line}`);
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
      // File doesn't exist, good
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
    } catch (e) {
      return { error: `Error: File ${filePath} does not exist.` };
    }

    if (!content.includes(oldString)) {
      return { error: `Error: old_string not found exactly once in file. Search failed.` };
    }

    // Count occurrences
    const count = (content.match(new RegExp(oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
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
    await fs.writeFile(filePath, content, 'utf-8');
    return { result: `Wrote ${filePath} successfully.` };
  }
}
