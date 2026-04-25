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
  const skillAliases: Map<string, string> = new Map(); // alias (dirname, etc) -> canonical skillName (lowercase)

  /**
   * Preload all skills into memory.
   * Stores the full SkillInfo for each skill, not just content.
   */
  async function preloadAll(): Promise<void> {
    const skills = await skillLoader.loadAllSkills();
    loadedSkills.clear();
    skillAliases.clear();
    for (const skill of skills) {
      const canonicalName = skill.name.toLowerCase();
      loadedSkills.set(canonicalName, skill);
      // Also store directory name as alias
      const dirName = path.basename(path.dirname(skill.filePath)).toLowerCase();
      if (dirName !== canonicalName) {
        skillAliases.set(dirName, canonicalName);
      }
    }
  }

  /**
   * beforeAgentRun hook: no-op, preloading already done at startup.
   */
  const beforeAgentRun: Middleware = async (_context, next) => {
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

    // Check early - don't do work if already injected AND no new skills mentioned
    // BUT: we need to check mentions FIRST because a new skill might be mentioned
    const lastUserMessage = [...context.messages]
      .reverse()
      .find(m => m.role === 'user');

    if (!lastUserMessage) {
      return next();
    }

    const userContent = lastUserMessage.content.toLowerCase();

    // Collect skills that are mentioned in the user message
    const mentionedSkills: SkillInfo[] = [];
    // No more Set needed - loadedSkills now has unique entries only
    for (const [skillName, skillInfo] of loadedSkills.entries()) {
      if (injectOnMention && userContent.includes(skillName)) {
        mentionedSkills.push(skillInfo);
      }
    }
    // Also check aliases (directory names)
    for (const [alias, canonicalName] of skillAliases.entries()) {
      if (injectOnMention && userContent.includes(alias)) {
        const skillInfo = loadedSkills.get(canonicalName)!;
        if (!mentionedSkills.includes(skillInfo)) {
          mentionedSkills.push(skillInfo);
        }
      }
    }

    // Check if already has skill system AND no new mentions
    const hasSkillSystem = context.systemPrompt?.includes('<skill_system>');
    if (hasSkillSystem && mentionedSkills.length === 0) {
      return next();
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

    // List all available skills - no more Set needed, loadedSkills has unique entries
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

    if (context.systemPrompt) {
      // If already has skill system, we'd have returned early. So this means:
      // Case 1: No skill system yet - inject it
      // Case 2: Had skill system but NEW skill was mentioned - we need to REPLACE the section
      if (hasSkillSystem) {
        // Remove old skill section and add updated one with new mention info
        context.systemPrompt = context.systemPrompt.replace(
          /\n\n<skill_system>[\s\S]*?<\/skill_system>/,
          skillSection
        );
      } else {
        context.systemPrompt += skillSection;
      }
    } else {
      context.systemPrompt = skillSection.trim();
    }

    return next();
  };

  /**
   * Get the loaded skill info by name.
   */
  function getSkill(skillName: string): SkillInfo | null {
    const key = skillName.toLowerCase();
    const canonicalName = skillAliases.get(key) ?? key;
    return loadedSkills.get(canonicalName) ?? null;
  }

  /**
   * Get the loaded skill content by name.
   */
  function getSkillContent(skillName: string): string | null {
    const skill = getSkill(skillName);
    return skill?.content ?? null;
  }

  /**
   * Clear the preloaded skills cache.
   */
  function clearCache(): void {
    loadedSkills.clear();
    skillAliases.clear();
  }

  /**
   * Register the skill loader with a provider to expose skills as tools.
   */
  function registerAsTools(_provider: Provider): void {
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
