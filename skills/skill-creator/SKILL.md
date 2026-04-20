---
name: skill-creator
description: "Guide for creating new skills in the correct format following the repository standards."
metadata:
  {
    "openclaw": {
      "emoji": "✍️",
      "requires": [],
    },
  }
---

# Skill Creator

Use this skill to create new skills for the agent skill system.

## Skill Format

Each skill is a directory under `skills/`:
```
skills/
  your-skill-name/
    SKILL.md       # Main skill content (required)
    _meta.json     # Metadata: version, publishedAt (auto-generated)
```

### SKILL.md Format

The file starts with YAML frontmatter, then markdown content.

```markdown
---
name: skill-name
description: "One-line description of what this skill does"
metadata:
  {
    "openclaw": {
      "emoji": "🔧",
      "requires": { "bins": ["required-binary"] },
      "install": [
        {
          "id": "brew",
          "kind": "brew",
          "formula": "formula-name",
          "bins": ["binary-name"],
          "label": "Install with Homebrew",
        },
      ],
    },
  }
---

# Skill Title

Content goes here...

- Detailed instructions
- Command reference
- Examples
- Common patterns
```

## Requirements

1. **Name**: Use kebab-case for the directory name and skill name
2. **Description**: One clear sentence describing what this skill does
3. **Metadata**: Include emoji, required binaries, and installation instructions if applicable
4. **Content**: Be comprehensive but concise - include everything the agent needs to use this skill
5. **Format**: Follow the exact frontmatter format shown above, including the metadata structure

## Steps to Create a New Skill

1. **Understand** what skill the user wants - what problem does it solve?
2. **Create** the directory `skills/<skill-name>/`
3. **Write** `SKILL.md` following the exact format above
4. **Create** `_meta.json` with:
   ```json
   {
     "slug": "<skill-name>",
     "version": "1.0.0",
     "publishedAt": <unix timestamp in ms>
   }
   ```
5. **Verify** the format is correct - frontmatter parses correctly, YAML is valid
6. **Confirm** with the user before finishing

## When to Use This Skill

Use this skill when:
- User asks you to create a new skill
- User wants to add a new reference skill to the repository
- You need to create a skill for a new command-line tool or API

Do NOT use this skill when:
- User just asks a question about an existing topic
- The information is already in an existing skill