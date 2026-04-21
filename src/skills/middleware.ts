import type { SkillInfo } from './loader';
import type { Middleware, Provider, AgentMiddleware } from '../types';
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
 * Result of createSkillMiddleware factory.
 */
export type SkillMiddlewareResult = AgentMiddleware & {
  /** Middleware for beforeAgentRun hook */
  beforeAgentRun: Middleware;
  /** Middleware for beforeModel hook - injects skill information every turn */
  beforeModel: Middleware;
  /** Preload all skills into memory (call at startup) */
  preloadAll: () => Promise<void>;
  /** Get the loaded skill info by name */
  getSkill: (skillName: string) => SkillInfo | null;
  /** Get the loaded skill content by name */
  getSkillContent: (skillName: string) => string | null;
  /** Clear the preloaded skills cache */
  clearCache: () => void;
  /** Register the skill loader with a provider to expose skills as tools */
  registerAsTools: (provider: Provider) => void;
};

/**
 * Creates skill middleware for structured skill injection into the system prompt
 * following the progressive loading pattern:
 * - All available skills are listed with their frontmatter metadata
 * - Full skill content is read on-demand using the text_editor tool when needed
 * - Structured XML formatting for better model understanding
 *
 * Architecture: injects skill information in beforeModel hook, which guarantees
 * the injection is applied to every model call even after getContext() recreates
 * the context object. This avoids the "modified system prompt lost" bug.
 */
export function createSkillMiddleware(
  options: Partial<SkillMiddlewareOptions> = {}
): SkillMiddlewareResult {
  const skillLoader = options.skillLoader ?? new SkillLoader();
  const autoInject = options.autoInject ?? true;
  const injectOnMention = options.injectOnMention ?? true;
  const loadedSkills: Map<string, SkillInfo> = new Map(); // skillName (lowercase) -> SkillInfo

  /**
   * Preload all skills into memory.
   * Stores the full SkillInfo for each skill, not just content.
   */
  async function preloadAll(): Promise<void> {
    const skills = await skillLoader.loadAllSkills();
    loadedSkills.clear();
    for (const skill of skills) {
      // Store by skill name (lowercase)
      loadedSkills.set(skill.name.toLowerCase(), skill);
      // Also store by directory name
      const dirName = path.basename(path.dirname(skill.filePath)).toLowerCase();
      if (dirName !== skill.name.toLowerCase()) {
        loadedSkills.set(dirName, skill);
      }
    }
  }

  /**
   * beforeAgentRun hook: no-op, preloading already done at startup.
   */
  const beforeAgentRun: Middleware = async (context, next) => {
    // Preloading done at startup, nothing to do here
    return next();
  };

  /**
   * beforeModel hook: inject skill system information into system prompt
   * before every model call. This guarantees skill info is never lost.
   */
  const beforeModel: Middleware = async (context, next) => {
    if (!autoInject) {
      return next();
    }

    // Find the last user message to check for skill mentions
    // This works across multiple turns - any turn can mention a new skill
    const lastUserMessage = [...context.messages]
      .reverse()
      .find(m => m.role === 'user');

    // Only inject when there's a user message (should always be true before model)
    if (!lastUserMessage) {
      return next();
    }

    const userContent = lastUserMessage.content.toLowerCase();

    // Collect skills that are mentioned in the user message
    const mentionedSkills: SkillInfo[] = [];
    for (const [skillName, skillInfo] of loadedSkills.entries()) {
      if (injectOnMention && userContent.includes(skillName)) {
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
      Array.from(loadedSkills.values()).map(s => ({
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

    // Inject into system prompt - every model call gets fresh injection
    if (context.systemPrompt) {
      context.systemPrompt += skillSection;
    } else {
      context.systemPrompt = skillSection.trim();
    }

    return next();
  };

  /**
   * Get the loaded skill info by name.
   */
  function getSkill(skillName: string): SkillInfo | null {
    return loadedSkills.get(skillName.toLowerCase()) ?? null;
  }

  /**
   * Get the loaded skill content by name.
   */
  function getSkillContent(skillName: string): string | null {
    const skill = loadedSkills.get(skillName.toLowerCase());
    return skill?.content ?? null;
  }

  /**
   * Clear the preloaded skills cache.
   */
  function clearCache(): void {
    loadedSkills.clear();
  }

  /**
   * Register the skill loader with a provider to expose skills as tools.
   */
  function registerAsTools(provider: Provider): void {
    // Future: skills can expose tools
    // For now, just structured injection is sufficient
  }

  return {
    preloadAll,
    beforeAgentRun,
    beforeModel,
    getSkill,
    getSkillContent,
    clearCache,
    registerAsTools,
  };
}
