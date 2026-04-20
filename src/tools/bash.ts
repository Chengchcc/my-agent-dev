import { exec } from 'child_process';
import path from 'path';
import type { Tool, ToolImplementation } from '../types';

/**
 * Options for BashTool.
 */
export type BashToolOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedWorkingDirs?: string[];
};

/**
 * Built-in tool for executing shell commands.
 * Similar to Anthropic Claude Platform's Bash tool.
 */
export class BashTool implements ToolImplementation {
  private timeoutMs: number;
  private maxOutputBytes: number;
  private allowedWorkingDirs?: string[];

  constructor(options: BashToolOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120000; // 2 minutes default
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024; // 1MB default
    this.allowedWorkingDirs = options.allowedWorkingDirs;
  }

  /**
   * Get the tool definition for function calling.
   */
  getDefinition(): Tool {
    return {
      name: 'bash',
      description: 'Execute a shell command on the local system. Use this for file operations, running scripts, installing dependencies, checking system status, git operations, and other command-line tasks.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the command (optional, defaults to current working directory).',
          },
        },
        required: ['command'],
      },
    };
  }

  /**
   * Execute the bash command.
   */
  async execute(params: { command: string; cwd?: string }): Promise<{
    output: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
  }> {
    const { command, cwd } = params;

    // Validate working directory if restricted
    if (this.allowedWorkingDirs) {
      const targetCwd = path.resolve(cwd ?? process.cwd());
      const isAllowed = this.allowedWorkingDirs.some(allowed => {
        const resolvedAllowed = path.resolve(allowed);
        return targetCwd === resolvedAllowed || targetCwd.startsWith(resolvedAllowed + path.sep);
      });
      if (!isAllowed) {
        return {
          output: `Error: Working directory "${targetCwd}" is not allowed.`,
          exitCode: 1,
          timedOut: false,
          truncated: false,
        };
      }
    }

    return new Promise((resolve) => {
      let output = '';
      let outputBytes = 0;
      let truncated = false;

      const proc = exec(command, {
        cwd: cwd,
        maxBuffer: this.maxOutputBytes,
        timeout: this.timeoutMs,
      });

      proc.stdout?.on('data', (data) => {
        const bytes = Buffer.byteLength(data);
        if (outputBytes + bytes > this.maxOutputBytes) {
          truncated = true;
          const remaining = this.maxOutputBytes - outputBytes;
          output += data.toString().slice(0, remaining);
          outputBytes = this.maxOutputBytes;
        } else {
          output += data.toString();
          outputBytes += bytes;
        }
      });

      proc.stderr?.on('data', (data) => {
        const bytes = Buffer.byteLength(data);
        if (outputBytes + bytes > this.maxOutputBytes) {
          truncated = true;
          const remaining = this.maxOutputBytes - outputBytes;
          output += data.toString().slice(0, remaining);
          outputBytes = this.maxOutputBytes;
        } else {
          output += data.toString();
          outputBytes += bytes;
        }
      });

      proc.on('error', (error) => {
        output += `Error: ${error.message}`;
        resolve({
          output,
          exitCode: 1,
          timedOut: false,
          truncated,
        });
      });

      proc.on('timeout', () => {
        proc.kill();
        output += `\n--- Command timed out after ${this.timeoutMs}ms ---`;
        resolve({
          output,
          exitCode: 124, // standard timeout exit code
          timedOut: true,
          truncated,
        });
      });

      proc.on('exit', (code, signal) => {
        if (signal) {
          output += `\n--- Killed by signal ${signal} ---`;
        }
        resolve({
          output,
          exitCode: code,
          timedOut: false,
          truncated,
        });
      });
    });
  }
}
