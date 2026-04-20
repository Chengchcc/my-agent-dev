import type { SkillInfo } from './loader';
import type { Middleware, Provider } from '../types';
import { SkillLoader } from './loader';
import path from 'path';

/**
 * Options for SkillMiddleware.
 */
export type SkillMiddlewareOptions = {
  skillLoader?: SkillLoader;
  autoInject: boolean;
  // Inject when user message contains the skill name (case-insensitive)
  injectOnMention: boolean;
};

/**
 * SkillMiddleware provides structured skill injection into the system prompt
 * following the progressive loading pattern:
 * - All available skills are listed with their frontmatter metadata
 * - Full skill content is read on-demand using the text_editor tool when needed
 * - Structured XML formatting for better model understanding
 */
export class SkillMiddleware {
  private skillLoader: SkillLoader;
  private autoInject: boolean;
  private injectOnMention: boolean;
  private loadedSkills: Map<string, SkillInfo> = new Map(); // skillName (lowercase) -> SkillInfo

  constructor(options: Partial<SkillMiddlewareOptions> = {}) {
    this.skillLoader = options.skillLoader ?? new SkillLoader();
    this.autoInject = options.autoInject ?? true;
    this.injectOnMention = options.injectOnMention ?? true;
  }

  /**
   * Preload all skills into memory.
   * Stores the full SkillInfo for each skill, not just content.
   */
  async preloadAll(): Promise<void> {
    const skills = await this.skillLoader.loadAllSkills();
    this.loadedSkills.clear();
    for (const skill of skills) {
      // Store by skill name (lowercase)
      this.loadedSkills.set(skill.name.toLowerCase(), skill);
      // Also store by directory name
      const dirName = path.basename(path.dirname(skill.filePath)).toLowerCase();
      if (dirName !== skill.name.toLowerCase()) {
        this.loadedSkills.set(dirName, skill);
      }
    }
  }

  /**
   * The middleware function that gets injected into the hook.
   */
  middleware(): Middleware {
    return async (context, next) => {
      if (!this.autoInject) {
        return next();
      }

      // Only run on beforeAgentRun
      const lastMessage = context.messages[context.messages.length - 1];
      if (lastMessage?.role !== 'user') {
        return next();
      }

      const userContent = lastMessage.content.toLowerCase();

      // Collect skills that are mentioned in the user message
      const mentionedSkills: SkillInfo[] = [];
      for (const [skillName, skillInfo] of this.loadedSkills.entries()) {
        if (this.injectOnMention && userContent.includes(skillName)) {
          mentionedSkills.push(skillInfo);
        }
      }

      // Build the skill system section
      let skillSection = `\n\n<skill_system>
You have access to skills that provide optimized workflows for specific tasks. Each skill contains best practices, frameworks, and references to additional resources.

**Progressive Loading Pattern:**
1. When a user query matches a skill's use case or a skill is explicitly mentioned, use the text_editor tool to read the skill's full content from its file path
2. Read and understand the skill's workflow and instructions precisely
3. Follow the skill's instructions exactly
4. The skill file may contain references to additional resources in the same folder - load those only when needed

`;

      // Add explicit invocation block if any skills are mentioned
      if (mentionedSkills.length > 0) {
        skillSection += `
<explicit_skill_invocation>
The user message mentions the following skill${mentionedSkills.length > 1 ? 's' : ''}:
${mentionedSkills.map(s => `- ${s.name}: ${s.description}\n  Path: ${s.filePath}`).join('\n')}

You must read the matching skill file${mentionedSkills.length > 1 ? 's' : ''} using the text_editor tool before proceeding.
</explicit_skill_invocation>
`;
      }

      // List all available skills with their frontmatter metadata
      const skillsJson = JSON.stringify(
        Array.from(this.loadedSkills.values()).map(s => ({
          name: s.name,
          description: s.description,
          path: s.filePath,
          metadata: s.metadata,
        })),
        null,
        2
      );

      skillSection += `
<skills>
${skillsJson}
</skills>
</skill_system>
`;

      // Inject into system prompt
      if (context.systemPrompt) {
        context.systemPrompt += skillSection;
      } else {
        context.systemPrompt = skillSection.trim();
      }

      return next();
    };
  }

  /**
   * Get the loaded skill info by name.
   */
  getSkill(skillName: string): SkillInfo | null {
    return this.loadedSkills.get(skillName.toLowerCase()) ?? null;
  }

  /**
   * Get the loaded skill content by name.
   */
  getSkillContent(skillName: string): string | null {
    const skill = this.loadedSkills.get(skillName.toLowerCase());
    return skill?.content ?? null;
  }

  /**
   * Clear the preloaded skills cache.
   */
  clearCache(): void {
    this.loadedSkills.clear();
  }

  /**
   * Register the skill loader with a provider to expose skills as tools.
   */
  registerAsTools(provider: Provider): void {
    // Future: skills can expose tools
    // For now, just structured injection is sufficient
  }
}
