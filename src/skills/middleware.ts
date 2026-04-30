import type { SkillInfo } from './loader';
import type { Middleware, AgentMiddleware } from '../types';
import { SkillLoader } from './loader';
import path from 'path';
import { debugLog } from '../utils/debug';

/**
 * Options for SkillMiddleware.
 */
export type SkillMiddlewareOptions = {
  skillLoader?: SkillLoader;
  autoInject: boolean;
  // Inject when user message contains the skill name (case-insensitive)
  injectOnMention: boolean;
  // Maximum number of mentioned skills to inject (tag matches always included first)
  maxInjectedSkills: number;
  // Maximum length for skill descriptions (security: prevents prompt bloat)
  maxDescriptionLength: number;
};

const DEFAULT_MAX_INJECTED_SKILLS = 3;
const DEFAULT_MAX_DESCRIPTION_LENGTH = 500;

/** Strip injection-looking XML tags from untrusted skill metadata. */
function sanitizeSkillDescription(desc: string): string {
  const tags = [
    'system-reminder', 'skill_catalog', 'skill_hint',
    'user_preferences', 'project_rules', 'retrieved_memory',
    'todo_status', 'explicit_skill_invocation',
  ];
  let result = desc;
  for (const tag of tags) {
    result = result
      .replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '')
      .replace(new RegExp(`</${tag}>`, 'gi'), '');
  }
  return result;
}

/** Cap description length and sanitize injection tags. */
function capDescription(desc: string, maxLen: number): string {
  const clean = sanitizeSkillDescription(desc);
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + '...';
}

/** Keyword overlap score between user query and skill description (0–1). */
function keywordScore(query: string, description: string): number {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'can', 'shall', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
    'through', 'during', 'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
    'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any',
    'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'than', 'too',
    'very', 'just', 'that', 'this', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  ]);
  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w)),
  );
  if (queryWords.size === 0) return 0;
  const descLower = description.toLowerCase();
  let overlap = 0;
  for (const w of queryWords) {
    if (descLower.includes(w)) overlap++;
  }
  return overlap / queryWords.size;
}

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
  /** Exposed for testing - loaded skills map */
  loadedSkills: Map<string, SkillInfo>;
  /** Exposed for testing - skill aliases map */
  skillAliases: Map<string, string>;
};

/**
 * Creates skill middleware for structured skill injection into the system prompt
 * following the progressive loading pattern:
 * - All available skills are listed with their frontmatter metadata (stable, cache-friendly)
 * - Full skill content is read on-demand using the text_editor tool when needed
 * - Explicit skill invocations are injected as ephemeral reminders (per-turn, auto-cleaned)
 *
 * Two-layer architecture:
 *   Layer 1: <skill_catalog> in system prompt — stable, version-hashed, cache-friendly
 *   Layer 2: <skill_hint> in ephemeralReminders — per-turn, mentions only, auto-cleaned
 */
export function createSkillMiddleware(
  options: Partial<SkillMiddlewareOptions> = {}
): SkillMiddlewareResult {
  const skillLoader = options.skillLoader ?? new SkillLoader();
  const autoInject = options.autoInject ?? true;
  const injectOnMention = options.injectOnMention ?? true;
  const maxInjectedSkills = options.maxInjectedSkills ?? DEFAULT_MAX_INJECTED_SKILLS;
  const maxDescriptionLength = options.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH;
  const loadedSkills: Map<string, SkillInfo> = new Map(); // skillName (lowercase) -> SkillInfo
  const skillAliases: Map<string, string> = new Map(); // alias (dirname, etc) -> canonical skillName (lowercase)
  const baseDir = path.resolve(skillLoader.getBasePath());

  /** Validate that a skill file path is within the base directory (prevent traversal attacks). */
  function validateSkillPath(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    return resolved.startsWith(baseDir + path.sep) || resolved === baseDir;
  }

  /**
   * Preload all skills into memory.
   */
  async function preloadAll(): Promise<void> {
    const skills = await skillLoader.loadAllSkills();
    loadedSkills.clear();
    skillAliases.clear();
    for (const skill of skills) {
      if (!validateSkillPath(skill.filePath)) {
        debugLog(`[skills] Skipping skill outside baseDir: ${skill.filePath}`);
        continue;
      }
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
    return next();
  };

  /**
   * Find mentioned skills in user content using two-layer matching:
   *   Layer A: /tag syntax — precise, high-priority match
   *   Layer B: substring match on skill name + aliases (legacy)
   */
  function findMentionedSkills(userContent: string): SkillInfo[] {
    const lower = userContent.toLowerCase();
    const explicitMatches: SkillInfo[] = []; // /tag syntax — always included
    const scoredMatches: Array<{ skill: SkillInfo; score: number }> = []; // substring matches

    // Layer A: /skill-name explicit tag syntax (highest priority, no limit)
    const tagRe = /(?:^|\s)\/([\w][\w-]*)(?:\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(lower)) !== null) {
      const tag = m[1]!;
      const canonicalName = skillAliases.get(tag) ?? tag;
      const skill = loadedSkills.get(canonicalName);
      if (skill && !explicitMatches.includes(skill)) {
        explicitMatches.push(skill);
      }
    }

    // Layer B: substring match on skill names with keyword scoring
    const alreadySeen = new Set(explicitMatches);
    const scoreAndAdd = (skill: SkillInfo) => {
      if (alreadySeen.has(skill)) return;
      alreadySeen.add(skill);
      const score = keywordScore(lower, skill.description);
      scoredMatches.push({ skill, score });
    };

    for (const [skillName, skillInfo] of loadedSkills.entries()) {
      if (lower.includes(skillName)) scoreAndAdd(skillInfo);
    }
    for (const [alias, canonicalName] of skillAliases.entries()) {
      if (lower.includes(alias)) {
        const skillInfo = loadedSkills.get(canonicalName)!;
        scoreAndAdd(skillInfo);
      }
    }

    // Sort scored matches by score descending
    scoredMatches.sort((a, b) => b.score - a.score);

    // Explicit matches first, then scored up to maxInjectedSkills
    const result = [...explicitMatches];
    const remaining = maxInjectedSkills - result.length;
    if (remaining > 0) {
      result.push(...scoredMatches.slice(0, remaining).map(s => s.skill));
    }

    return result;
  }

  /** Format skill hint as a system-reminder for ephemeral injection. */
  function formatSkillHint(skills: SkillInfo[]): string {
    const items = skills.map(s => `- ${s.name}: ${capDescription(s.description, maxDescriptionLength)}\n  Path: ${s.filePath}`).join('\n');
    return `<system-reminder>
<skill_hint matched="${skills.map(s => s.name).join(',')}">
The user message mentions the following skill${skills.length > 1 ? 's' : ''}:
${items}

Read the matching skill file${skills.length > 1 ? 's' : ''} using the text_editor tool before proceeding.
</skill_hint>
</system-reminder>`;
  }

  /** Simple DJB2 hash for content-based versioning of skill catalog. */
  function hashCatalog(entries: Array<{ name: string; description: string; path: string }>): string {
    const text = JSON.stringify(entries);
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * beforeModel hook: inject skill catalog into system prompt (stable, version-hashed)
   * and skill hints into ephemeralReminders (per-turn, auto-cleaned).
   */
  const beforeModel: Middleware = async (context, next) => {
    if (!autoInject) return next();

    // Layer 1: Skill catalog — stable system prompt section with version hash
    const catalogEntries = Array.from(loadedSkills.values()).map(s => ({
      name: s.name,
      description: capDescription(s.description, maxDescriptionLength),
      path: s.filePath,
    }));
    const catalogVersion = hashCatalog(catalogEntries);
    const catalogJson = JSON.stringify(catalogEntries);

    // Strip previous catalog, then re-add
    const stripCatalog = (prompt: string): string =>
      prompt.replace(
        /\n\n<skill_catalog[^>]*>[\s\S]*?<\/skill_catalog>/g,
        '',
      ).trim();

    const base = stripCatalog(context.systemPrompt || '');

    const catalogSection = `<skill_catalog version="${catalogVersion}">
You have access to skills that provide optimized workflows for specific tasks.
Each skill's full content can be read using the text_editor tool when needed.

**Progressive Loading Pattern:**
1. When a user query matches a skill's use case or a skill is explicitly mentioned,
   use the text_editor tool to read the skill's full content from its file path
2. Read and understand the skill's workflow and instructions precisely
3. Follow the skill's instructions exactly
4. The skill file may reference additional resources in the same folder —
   load those only when needed

<skills>
${catalogJson}
</skills>
</skill_catalog>`;

    context.systemPrompt = [base, catalogSection].filter(Boolean).join('\n\n');

    // Layer 2: Explicit skill invocation — ephemeral reminder (per-turn, auto-cleaned)
    const lastUserMessage = [...context.messages]
      .reverse()
      .find(m => m.role === 'user');

    if (lastUserMessage && injectOnMention) {
      const mentionedSkills = findMentionedSkills(lastUserMessage.content);
      if (mentionedSkills.length > 0) {
        context.ephemeralReminders ??= [];
        context.ephemeralReminders.push(formatSkillHint(mentionedSkills));
      }
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

  return {
    preloadAll,
    beforeAgentRun,
    beforeModel,
    getSkill,
    getSkillContent,
    clearCache,
    // Exposed for testing
    loadedSkills,
    skillAliases,
  };
}
