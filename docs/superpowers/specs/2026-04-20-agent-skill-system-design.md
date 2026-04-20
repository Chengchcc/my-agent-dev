# Agent Skill System with Hooks - Design Document

## Overview

Extend the agent with:
1. **Fine-grained hook points** in the agent execution loop based on the existing middleware architecture
2. **Skill loading system** that loads skills from the `skills/` directory (markdown format with frontmatter)
3. **SkillCreator skill** - a skill that teaches the agent how to create new skills following the standard format

## Background

Current architecture:
- `Agent` uses onion-style middleware via `composeMiddlewares`
- Skills already exist in `skills/` directory as markdown files (e.g., `github-cli`)
- Middleware can intercept the entire agent run, but no fine-grained hooks for specific phases

## Design

### 1. Agent Loop Hooks

We add fine-grained hook points to the existing middleware architecture. The entire agent run becomes:

```
beforeAgentRun → [add user message] → beforeCompress → [compress context] → beforeModel → [call LLM provider] → afterModel → [parse response] → beforeAddResponse → [add response to context] → afterAgentRun
```

Each phase is wrapped by middleware that can:
- Inspect and modify the context
- Skip the phase by not calling `next()`
- Add metadata
- Execute side effects

#### Type Changes (`src/types.ts`)

No breaking changes. We add new optional fields to `Agent` constructor:

```typescript
export interface AgentHooks {
  beforeAgentRun?: Middleware[];
  beforeCompress?: Middleware[];
  beforeModel?: Middleware[];
  afterModel?: Middleware[];
  beforeAddResponse?: Middleware[];
  afterAgentRun?: Middleware[];
}
```

The `Agent` constructor accepts `hooks?: AgentHooks` in options. The existing `middleware` option remains as the outer wrapper around the entire run.

### 2. Skill System

#### Skill Definition Format

Each skill is a directory under `skills/`:
```
skills/
  skill-name/
    SKILL.md       # skill content (required)
    _meta.json     # metadata (version, owner, etc.)
```

**SKILL.md format:**
```markdown
---
name: skill-name
description: "One-line description what this skill does"
metadata:
  {
    "openclaw": {
      "emoji": "🔧",
      "requires": { "bins": ["command-name"] },
      "install": [...]
    }
  }
---

# Skill Title

Skill content goes here...
- Instructions
- Examples
- Command references
```

#### SkillLoader (`src/skills/loader.ts`)

Responsibilities:
- Scan `skills/` directory
- Read `SKILL.md` and parse frontmatter
- Validate skill format
- Provide list of loaded skills

```typescript
export type SkillInfo = {
  name: string;
  description: string;
  content: string;
  path: string;
  metadata: Record<string, unknown>;
};

export class SkillLoader {
  constructor(basePath?: string);
  async loadAllSkills(): Promise<SkillInfo[]>;
  async loadSkill(skillName: string): Promise<SkillInfo | null>;
  listSkills(): string[];
}
```

#### SkillMiddleware (`src/skills/middleware.ts`)

Middleware that automatically injects available skills into the system prompt when the user query mentions a skill. Also registers skills as tools if they expose functions.

**Behavior:**
- On `beforeAgentRun`, check if user message mentions any loaded skill name
- If yes, inject skill content into the context's system prompt
- If skill can be invoked as a tool, register it with the provider

### 3. SkillCreator Skill

A skill in `skills/skill-creator/SKILL.md` that teaches the agent how to create new skills. It follows the same format as all other skills. It contains:

- The skill format specification (frontmatter, structure, content)
- Requirements for a good skill
- Example skill structure
- Instructions to write the file to disk when done

When a user says "create a new skill for X", the agent uses the skill-creator skill instructions to generate a properly formatted skill and write it to the correct directory.

## File Structure

```
src/
  types.ts          # add AgentHooks interface
  agent.ts          # modify Agent to support hooks
  skills/
    index.ts        # exports
    loader.ts       # SkillLoader
    middleware.ts   # SkillMiddleware
skills/
  skill-creator/
    SKILL.md
    _meta.json
```

## Testing

- Unit tests for SkillLoader (parsing frontmatter, directory scanning)
- Unit tests for hook execution order
- Integration test: load an existing skill, verify it gets injected
- Integration test: use skill-creator to create a test skill, verify output format

## Trade-offs

- **Pure middleware extension**: Keeps the existing architecture consistent, no new concepts
- **Filesystem-based**: Skills are easy to version control and edit manually
- **Markdown format**: Human-readable, works with Claude Code skill system
- **No breaking changes**: Existing code continues to work

## Built-in Tools

Implement the following built-in tools similar to Anthropic Claude Platform:

### BashTool

Execute shell commands on the local system.

```typescript
// tool definition
{
  name: "bash",
  description: "Run a shell command on the local system. Use for file operations, building, testing, etc.",
  parameters: {
    command: {
      type: "string",
      description: "The shell command to execute"
    },
    cwd: {
      type: "string",
      description: "Working directory for the command (optional)",
    }
  }
}
```

Supports timeout, captures stdout/stderr, returns output to the agent.

### TextEditorTool

Read, write, and edit text files.

```typescript
// commands:
// - view: show file content
// - create: create new file
// - str_replace: replace string in file
// - write: write entire file

{
  name: "text_editor",
  description: "Read, create, edit, and write text files",
  parameters: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "write"],
      description: "The command to execute"
    },
    path: {
      type: "string",
      description: "Absolute path to the file"
    },
    // for view: optional line range
    // for str_replace: old_string, new_string
    // for create/write: content
  }
}
```

Follows the same pattern as Anthropic's text editor tool.

## Success Criteria

1. Agent runs with hooks execute in the correct order
2. Skills can be loaded from `skills/` directory
3. SkillMiddleware correctly injects skill content when mentioned
4. skill-creator skill exists and can guide the agent to create new skills
5. `BashTool` and `TextEditorTool` built-in tools implemented
6. All tests compile and pass
7. Code style matches existing project
