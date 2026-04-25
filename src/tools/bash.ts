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
    this.allowedWorkingDirs = options.allowedWorkingDirs ?? [];
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
  async execute(
    params: { command: string; cwd?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{
    output: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
  }> {
    const { command, cwd } = params;

    // Validate working directory if restricted (empty array = no restrictions)
    if (this.allowedWorkingDirs && this.allowedWorkingDirs.length > 0) {
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
        maxBuffer: 10 * 1024 * 1024, // 10MB - let manual truncation below handle our limit
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

      let resolved = false;

      // Handle abort signal
      if (options?.signal) {
        const handleAbort = () => {
          // Already resolved - do nothing
          if (resolved) return;

          // Clean up the listener immediately since we've been triggered
          cleanup();
          if (proc && proc.pid) {
            // Negative PID kills the entire process group
            // This fails on non-detached exec for some systems, so fall back to killing just the child
            try {
              process.kill(-proc.pid);
            } catch {
              // Fall back to killing just the main process if group kill fails
              try {
                proc.kill();
              } catch {
                // Ignore errors when process already exited
              }
            }
          }
          output += `\n--- Command aborted by user ---`;
          resolved = true;
          resolve({
            output,
            exitCode: 130, // SIGTERM exit code
            timedOut: false,
            truncated,
          });
        };

        options.signal.addEventListener('abort', handleAbort);

        // Cleanup listener when done
        const cleanup = () => {
          options.signal?.removeEventListener('abort', handleAbort);
        };

        proc.on('exit', cleanup);
        proc.on('timeout', cleanup);
        proc.on('error', cleanup);

        // If already aborted, trigger immediately
        if (options.signal.aborted) {
          handleAbort();
        }
      }

      proc.on('timeout', () => {
        proc.kill();
        output += `\n--- Command timed out after ${this.timeoutMs}ms ---`;
        resolved = true;
        resolve({
          output,
          exitCode: 124, // standard timeout exit code
          timedOut: true,
          truncated,
        });
      });

      proc.on('exit', (code, signal) => {
        if (resolved) {
          return; // Already resolved by timeout handler
        }
        if (signal) {
          output += `\n--- Killed by signal ${signal} ---`;
        }
        // Check if the process was killed due to timeout (even if we didn't get the timeout event)
        const timedOut = this.timeoutMs > 0 && signal === 'SIGTERM';
        const exitCode = timedOut ? 124 : code;
        resolve({
          output,
          exitCode,
          timedOut,
          truncated,
        });
      });
    });
  }
}
