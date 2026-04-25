import { TextEditorTool } from '../../src/tools';
import { describe, expect, test } from 'bun:test';
import { createTestCtx } from '../agent/tool-dispatch/test-helpers';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

describe('TextEditorTool', () => {
  async function createTempFile(content: string): Promise<string> {
    const tmpDir = os.tmpdir();
    const filePath = path.join(tmpDir, `test-${Date.now()}.txt`);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  test('view reads entire file', async () => {
    const content = 'line 1\nline 2\nline 3';
    const filePath = await createTempFile(content);
    const tool = new TextEditorTool();
    const result = await tool.execute({ command: 'view', path: filePath }, createTestCtx());
    expect('result' in result).toBe(true);
    expect((result as any).result).toBe(content);
    await fs.unlink(filePath);
  });

  test('create new file fails if exists', async () => {
    const filePath = await createTempFile('existing');
    const tool = new TextEditorTool();
    const result = await tool.execute({ command: 'create', path: filePath, content: 'new' }, createTestCtx());
    expect('error' in result).toBe(true);
    expect((result as any).error).toContain('already exists');
    await fs.unlink(filePath);
  });

  test('str_replace replaces exact string', async () => {
    const content = 'hello world\nhello test\nhello world';
    const filePath = await createTempFile(content);
    const tool = new TextEditorTool();
    // Only one occurrence of "hello test"
    const result = await tool.execute({
      command: 'str_replace',
      path: filePath,
      old_string: 'hello test',
      new_string: 'hello replaced',
    }, createTestCtx());
    expect('result' in result).toBe(true);
    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toContain('hello replaced');
    await fs.unlink(filePath);
  });

  test('str_replace fails if multiple occurrences', async () => {
    const content = 'hello\nhello\nhello';
    const filePath = await createTempFile(content);
    const tool = new TextEditorTool();
    const result = await tool.execute({
      command: 'str_replace',
      path: filePath,
      old_string: 'hello',
      new_string: 'bye',
    }, createTestCtx());
    expect('error' in result).toBe(true);
    expect((result as any).error).toContain('found 3 times');
    await fs.unlink(filePath);
  });

  test('write overwrites existing file', async () => {
    const filePath = await createTempFile('old content');
    const tool = new TextEditorTool();
    const result = await tool.execute({
      command: 'write',
      path: filePath,
      content: 'new content',
    }, createTestCtx());
    expect('result' in result).toBe(true);
    const newContent = await fs.readFile(filePath, 'utf-8');
    expect(newContent).toBe('new content');
    await fs.unlink(filePath);
  });
});