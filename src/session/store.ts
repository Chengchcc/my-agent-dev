import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getSettingsSync } from '../config';
import { defaultSettings } from '../config/defaults';
import type { Message } from '../types';

const SESSION_PREVIEW_MAX_LENGTH = 100;

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastUserMessage: string;
}

export class SessionStore {
  private sessionDir: string;
  private currentSessionId: string | null = null;

  constructor() {
    try {
      const settings = getSettingsSync();
      this.sessionDir = settings.tui.sessions.dir;
    } catch {
      this.sessionDir = defaultSettings.tui.sessions.dir;
    }
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  getSessionId(): string | null {
    return this.currentSessionId;
  }

  setCurrentSessionId(id: string): void {
    this.currentSessionId = id;
  }

  async ensureSessionDir(): Promise<void> {
    try {
      await fs.access(this.sessionDir);
    } catch {
      await fs.mkdir(this.sessionDir, { recursive: true });
    }
  }

  createNewSession(): SessionMetadata {
    const id = crypto.randomUUID();
    this.currentSessionId = id;
    const now = new Date().toISOString();
    const metadata: SessionMetadata = {
      id,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastUserMessage: '',
    };
    return metadata;
  }

  private getPaths(sessionId: string): {
    jsonlPath: string;
    metaPath: string;
  } {
    return {
      jsonlPath: path.join(this.sessionDir, `${sessionId}.jsonl`),
      metaPath: path.join(this.sessionDir, `${sessionId}.json`),
    };
  }

  async saveSession(sessionId: string, messages: Message[]): Promise<void> {
    await this.ensureSessionDir();
    const { jsonlPath, metaPath } = this.getPaths(sessionId);

    // Write JSONL - one message per line, filter out ephemeral injections
    const jsonlContent = messages
      .filter(msg => !msg._ephemeral)
      .map(msg => JSON.stringify(msg))
      .join('\n');
    await fs.writeFile(jsonlPath, jsonlContent, 'utf8');

    // Extract last user message for metadata preview
    const lastUserMsg = messages
      .filter(msg => msg.role === 'user')
      .pop();

    // Get existing createdAt or create new
    let createdAt = new Date().toISOString();
    try {
      const existing = await this.readExistingMetadata(sessionId);
      createdAt = existing.createdAt;
    } catch {
      // New session - createdAt will be now
    }

    // Update metadata
    const metadata: SessionMetadata = {
      id: sessionId,
      createdAt,
      updatedAt: new Date().toISOString(),
      messageCount: messages.length,
      lastUserMessage: lastUserMsg?.content.slice(0, SESSION_PREVIEW_MAX_LENGTH) || '',
    };

    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
  }

  private async readExistingMetadata(sessionId: string): Promise<SessionMetadata> {
    const { metaPath } = this.getPaths(sessionId);
    const content = await fs.readFile(metaPath, 'utf8');
    return JSON.parse(content) as SessionMetadata;
  }

  async loadSession(sessionId: string): Promise<Message[]> {
    const { jsonlPath } = this.getPaths(sessionId);
    const content = await fs.readFile(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() !== '');
    return lines.map(line => JSON.parse(line) as Message);
  }

  async listSessions(): Promise<SessionMetadata[]> {
    await this.ensureSessionDir();
    const files = await fs.readdir(this.sessionDir);

    // Get all .json metadata files
    const metaFiles = files.filter(f => f.endsWith('.json'));
    const sessions: SessionMetadata[] = [];

    for (const file of metaFiles) {
      const sessionId = file.replace(/\.json$/, '');
      try {
        const { metaPath } = this.getPaths(sessionId);
        const content = await fs.readFile(metaPath, 'utf8');
        const metadata = JSON.parse(content) as SessionMetadata;
        sessions.push(metadata);
      } catch {
        // Skip corrupted metadata
        continue;
      }
    }

    // Sort by updatedAt descending - newest first
    return sessions.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    const { jsonlPath, metaPath } = this.getPaths(sessionId);
    try {
      await fs.unlink(jsonlPath);
    } catch {
      // Ignore if file doesn't exist
    }
    try {
      await fs.unlink(metaPath);
    } catch {
      // Ignore if file doesn't exist
    }
  }
}
