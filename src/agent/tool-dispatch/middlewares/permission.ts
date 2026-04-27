import type { ToolMiddleware } from '../middleware';
import type { ToolCall } from '../../../types';
import { globalPermissionManager } from '../../../tools/permission-manager';

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf?\b/, reason: 'destructive file deletion (rm -rf)' },
  { pattern: /\bsudo\b/, reason: 'privilege escalation (sudo)' },
  { pattern: /\bchmod\s+.*777/, reason: 'world-writable permissions (chmod 777)' },
  { pattern: /\bchmod\s+-R\b/, reason: 'recursive permission change' },
  { pattern: /\bchown\b/, reason: 'file ownership change' },
  { pattern: />\s*\/dev\//, reason: 'writing to block device' },
  { pattern: /\bmkfs\b/, reason: 'filesystem creation' },
  { pattern: /\bdd\s+if=/, reason: 'direct device I/O' },
  { pattern: /\bcurl\b.+\|\s*(?:ba)?sh\b/, reason: 'curling untrusted content into shell' },
  { pattern: /\bwget\b.+\|\s*(?:ba)?sh\b/, reason: 'piping downloaded content to shell' },
  { pattern: /:\(\)\s*\{/, reason: 'fork bomb pattern' },
  { pattern: /\/etc\/(?:passwd|shadow)/, reason: 'modifying system auth files' },
  { pattern: /\bgit\s+push\s+(?:--force|-f)\b.*(?:main|master)/, reason: 'force-pushing to protected branch' },
];

function detectDangerousCommand(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

function extractCommand(toolCall: ToolCall): string | null {
  if (toolCall.name !== 'bash') return null;
  const cmd = toolCall.arguments?.command;
  if (typeof cmd === 'string') return cmd;
  return null;
}

const PERMISSION_TIMEOUT_MS = 10_000;

export class PermissionMiddleware implements ToolMiddleware {
  name = 'permission';

  constructor(private rules: { denyInSubAgent: string[] }) {}

  async handle(toolCall: ToolCall, ctx: any, next: () => Promise<unknown>): Promise<unknown> {
    // Check sub-agent restrictions
    if (ctx.environment?.agentType === 'sub_agent'
        && this.rules.denyInSubAgent.includes(toolCall.name)) {
      throw new Error(`Tool '${toolCall.name}' is not allowed in sub agent context`);
    }

    // Check dangerous bash commands
    const command = extractCommand(toolCall);
    if (command) {
      const danger = detectDangerousCommand(command);
      if (danger) {
        const reason = `Command: "${command.slice(0, 80)}${command.length > 80 ? '...' : ''}" — ${danger}`;

        let response: 'allow' | 'deny' | 'always';
        try {
          response = await Promise.race([
            globalPermissionManager.requestPermission('bash', reason),
            new Promise<'deny'>((resolve) =>
              setTimeout(() => resolve('deny'), PERMISSION_TIMEOUT_MS),
            ),
          ]);
        } catch {
          response = 'deny';
        }

        if (response === 'deny') {
          throw new Error(`Permission denied: ${danger}. Use 'always' to approve this pattern.`);
        }
      }
    }

    return next();
  }
}
