# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

This is a TypeScript-based AI agent framework built with Bun, featuring a modular architecture for extending functionality through skills. The project is actively under development.

## Development Commands

- **Compile TypeScript**: `bun run tsc`
- **TypeScript version**: ^6.0.3

## Architecture

### Core Files

- `/src/index.ts`: Main entry point with public exports
- `/src/agent.ts`: Agent core functionality
- `/src/context.ts`: Context management for agent runs
- `/src/types.ts`: Type definitions for middleware, providers, etc.
- `/src/middleware.ts`: Base middleware class
- `/src/foundation/providers/`: Claude and OpenAI provider implementations
- `/src/skills/`: Skill management and injection system
  - `loader.ts`: SkillLoader class for loading skills from disk with caching
  - `middleware.ts`: SkillMiddleware for auto-injecting skills into system prompt

## Important Files

- `tsconfig.json`: TypeScript configuration
- `package.json`: Project dependencies
- `skills/`: Directory containing available skills (each in separate folder with SKILL.md)

## Getting Started

When adding code to this repository:
1. Understand the project requirements and architecture
2. Update this file with relevant commands and architecture documentation as the project takes shape
