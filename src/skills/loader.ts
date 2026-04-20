import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';

export type SkillInfo = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  metadata: Record<string, unknown>;
};

export class SkillLoader {
  private basePath: string;
  private cachedSkills: Map<string, SkillInfo> = new Map();

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.resolve(process.cwd(), 'skills');
  }

  /**
   * List all skill directory names under the base path.
   */
  async listSkillNames(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.basePath, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (e) {
      // If directory doesn't exist, return empty
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw e;
    }
  }

  /**
   * Load a single skill by name.
   * Reads SKILL.md, parses frontmatter, caches the result.
   */
  async loadSkill(skillName: string): Promise<SkillInfo | null> {
    // Check cache first
    if (this.cachedSkills.has(skillName)) {
      return this.cachedSkills.get(skillName)!;
    }

    const skillDir = path.join(this.basePath, skillName);
    const skillPath = path.join(skillDir, 'SKILL.md');

    try {
      const content = await fs.readFile(skillPath, 'utf-8');
      const { data, content: markdownContent } = matter(content);

      const skillInfo: SkillInfo = {
        name: data.name ?? skillName,
        description: data.description ?? '',
        content: markdownContent,
        filePath: skillPath,
        metadata: data.metadata ?? {},
      };

      this.cachedSkills.set(skillName, skillInfo);
      return skillInfo;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw e;
    }
  }

  /**
   * Load all available skills.
   */
  async loadAllSkills(): Promise<SkillInfo[]> {
    const names = await this.listSkillNames();
    const skills: SkillInfo[] = [];

    for (const name of names) {
      const skill = await this.loadSkill(name);
      if (skill) {
        skills.push(skill);
      }
    }

    return skills;
  }

  /**
   * Clear the skill cache. Forces reloading from disk on next load.
   */
  clearCache(): void {
    this.cachedSkills.clear();
  }

  /**
   * Get the base path where skills are loaded from.
   */
  getBasePath(): string {
    return this.basePath;
  }
}
