import { SkillLoader } from '../../src/skills';
import { describe, expect, test } from 'bun:test';

describe('SkillLoader', () => {
  test('loads existing skill-creator', async () => {
    const loader = new SkillLoader();
    const skill = await loader.loadSkill('skill-creator');
    expect(skill).not.toBeNull();
    expect(skill?.name).toBe('skill-creator');
    expect(skill?.description).toContain('Guide for creating new skills');
    expect(skill?.content).toContain('## Skill Format');
  });

  test('returns null for non-existent skill', async () => {
    const loader = new SkillLoader();
    const skill = await loader.loadSkill('non-existent-skill');
    expect(skill).toBeNull();
  });

  test('lists all skills', async () => {
    const loader = new SkillLoader();
    const names = await loader.listSkillNames();
    expect(names).toContain('skill-creator');
  });

  test('loads all skills', async () => {
    const loader = new SkillLoader();
    const skills = await loader.loadAllSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some(s => s.name === 'skill-creator')).toBe(true);
  });
});
