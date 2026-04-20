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
 * SkillMiddleware automatically detects mentions of skills in user messages
 * and injects the skill content into the system prompt when mentioned.
 */
export class SkillMiddleware {
  private skillLoader: SkillLoader;
  private autoInject: boolean;
  private injectOnMention: boolean;
  private loadedSkills: Map<string, string> = new Map(); // skillName -> full content

  constructor(options: Partial<SkillMiddlewareOptions> = {}) {
    this.skillLoader = options.skillLoader ?? new SkillLoader();
    this.autoInject = options.autoInject ?? true;
    this.injectOnMention = options.injectOnMention ?? true;
  }

  /**
   * Preload all skills into memory for faster injection.
   */
  async preloadAll(): Promise<void> {
    const skills = await this.skillLoader.loadAllSkills();
    this.loadedSkills.clear();
    for (const skill of skills) {
      // Store the full skill content with frontmatter content
      this.loadedSkills.set(skill.name.toLowerCase(), skill.content);
      // Also store by directory name
      const dirName = path.basename(path.dirname(skill.filePath)).toLowerCase();
      if (dirName !== skill.name.toLowerCase()) {
        this.loadedSkills.set(dirName, skill.content);
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
      const skillsToInject: string[] = [];

      // Check which skills are mentioned
      for (const [skillName, content] of this.loadedSkills.entries()) {
        if (userContent.includes(skillName)) {
          skillsToInject.push(content);
        }
      }

      // If any skills matched, inject them into system prompt
      if (skillsToInject.length > 0) {
        const skillSection = '\n\n---\n# Reference Skills\n\n' + skillsToInject.join('\n\n---\n\n');
        if (context.systemPrompt) {
          context.systemPrompt += skillSection;
        } else {
          context.systemPrompt = skillSection.trim();
        }
      }

      return next();
    };
  }

  /**
   * Get the loaded skill content by name.
   */
  getSkillContent(skillName: string): string | null {
    return this.loadedSkills.get(skillName.toLowerCase()) ?? null;
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
    // For now, just content injection is sufficient
  }
}
