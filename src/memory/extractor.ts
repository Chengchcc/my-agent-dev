import crypto from 'crypto';
import type { Message, Provider, AgentContext } from '../types';
import type { MemoryEntry, MemoryExtractor } from './types';

export class LlmExtractor implements MemoryExtractor {
  constructor(
    private provider: Provider,
    private extractionModel: string = 'claude-3-5-haiku-20241022',
  ) {}

  async extract(messages: Message[], projectPath?: string): Promise<MemoryEntry[]> {
    const conversationText = this.formatMessages(messages);

    const prompt = this.buildExtractionPrompt(conversationText, projectPath);

    const response = await this.invokeLlm(prompt);

    return this.parseExtractedResponse(response, projectPath);
  }

  async consolidate(entries: MemoryEntry[]): Promise<MemoryEntry[]> {
    const prompt = this.buildConsolidationPrompt(entries);
    const response = await this.invokeLlm(prompt);
    return this.parseConsolidatedResponse(response);
  }

  private formatMessages(messages: Message[]): string {
    return messages
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');
  }

  private buildExtractionPrompt(conversation: string, projectPath?: string): string {
    return `Analyze this conversation and extract memory entries for a persistent agent memory system.

Extract exactly these types of information:
1. User preferences or habits (e.g. "prefers pnpm over npm", "uses vitest instead of jest")
2. Facts about the current project (e.g. "uses TypeScript with Bun", "structure: src/agent/, src/cli/")
3. Key decisions made (e.g. "decided to store memory in JSONL files")
4. Important outcomes (e.g. "refactored agent.ts into three files", "fixed markdown rendering bug")

Rules:
- ONLY extract genuinely useful, reusable information that will help in future conversations
- Skip transient, one-time things like "user asked a question about X"
- Each entry should be a single, clear statement
- NEVER extract API keys, passwords, tokens, or other sensitive credentials
- If an entry mentions credentials, omit the actual value and only note that the project uses it
- Return a JSON array of objects with this shape:
  [{"type": "semantic" | "episodic" | "project", "text": string, "tags": string[] | undefined, "weight": number (0-1)}]
- If nothing worth remembering, return an empty array []

${projectPath ? `This conversation is in project: ${projectPath}` : ''}

Conversation:
${conversation}`;
  }

  private buildConsolidationPrompt(entries: MemoryEntry[]): string {
    return `Consolidate these memory entries:

1. Merge duplicate or very similar entries - keep the more specific, recent version
2. If entries conflict, keep the newer one with higher weight
3. Remove outdated, irrelevant, or transient entries that are no longer useful
4. Combine related entries into clearer, more concise statements
5. Preserve all important user preferences and project facts
6. DO NOT remove information unless it's definitely a duplicate or outdated
7. If an entry is not changed/merged, preserve its original \`id\`, \`created\`, \`source\`, \`projectPath\` fields

Return a JSON array of consolidated entries with this shape:
[{"type": "semantic" | "episodic" | "project", "text": string, "tags": string[] | undefined, "weight": number (0-1), "id": string | undefined, "created": string | undefined, "source": string | undefined, "projectPath": string | undefined}]

Entries:
${entries.map((e, i) => `[${i + 1}] ${e.text} (created: ${e.created})`).join('\n')}`;
  }

  private async invokeLlm(prompt: string): Promise<string> {
    // Create a minimal context for the provider invoke
    const context: AgentContext = {
      messages: [{ role: 'user' as const, content: prompt }],
      config: { tokenLimit: 100000, model: this.extractionModel },
      metadata: {},
    };

    // We need to set the model - the provider should already be configured
    // Use the extraction model specified in constructor
    // Note: This assumes the provider is already initialized with the correct API key
    const response = await this.provider.invoke(context);
    return response.content;
  }

  private parseExtractedResponse(
    content: string,
    projectPath?: string,
  ): MemoryEntry[] {
    try {
      // Find JSON array in the response (handle extra text)
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        id?: string;
        type?: MemoryEntry['type'];
        text?: string;
        tags?: string[];
        created?: string;
        weight?: number;
        source?: MemoryEntry['source'];
        projectPath?: string;
        metadata?: Record<string, unknown>;
        files?: string[];
      }>;

      const now = new Date().toISOString();
      return parsed
        .filter(p => p.text && p.type)
        .map(p => {
          const entry: MemoryEntry = {
            id: p.id ?? crypto.randomUUID(),
            type: p.type!,
            text: p.text!,
            created: p.created ?? now,
            weight: p.weight ?? 0.8,
            source: p.source ?? ('implicit' as const),
          };
          if (p.tags?.length) entry.tags = p.tags;
          if (p.type === 'project' && projectPath) entry.projectPath = projectPath;
          if (p.metadata) entry.metadata = p.metadata;
          if (p.files?.length) entry.files = p.files;
          return entry;
        })
        .filter(p => p.text.trim().length > 0);
    } catch {
      // If parsing fails, return empty - no extraction
      return [];
    }
  }

  private parseConsolidatedResponse(content: string): MemoryEntry[] {
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        id?: string;
        type?: MemoryEntry['type'];
        text?: string;
        tags?: string[];
        weight?: number;
        created?: string;
        source?: MemoryEntry['source'];
        projectPath?: string;
        metadata?: Record<string, unknown>;
        files?: string[];
      }>;

      const now = new Date().toISOString();
      return parsed
        .filter(p => p.text && p.type)
        .map(p => {
          const entry: MemoryEntry = {
            id: p.id ?? crypto.randomUUID(),
            type: p.type!,
            text: p.text!,
            created: p.created ?? now,
            weight: p.weight ?? 0.8,
            source: p.source ?? ('implicit' as const),
          };
          if (p.tags?.length) entry.tags = p.tags;
          if (p.projectPath) entry.projectPath = p.projectPath;
          if (p.metadata) entry.metadata = p.metadata;
          if (p.files?.length) entry.files = p.files;
          return entry;
        })
        .filter(p => p.text.trim().length > 0);
    } catch {
      return [];
    }
  }
}

