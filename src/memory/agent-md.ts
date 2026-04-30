import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

export interface AgentMdSource {
  path: string;
  scope: 'global' | 'project' | 'cwd';
  content: string;
  mtime: number;
}

const CANDIDATE_NAMES = ['AGENT.md', 'CLAUDE.md', '.agentrules'];
const MAX_FILE_SIZE = 100 * 1024;          // 100KB hard limit per file
const MAX_IMPORT_DEPTH = 3;                 // prevent infinite @import recursion
const MAX_TOTAL_SIZE = 256 * 1024;          // 256KB total merged limit

async function findProjectRoot(cwd: string): Promise<string | null> {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function tryRead(dir: string, scope: AgentMdSource['scope']): Promise<AgentMdSource[]> {
  const out: AgentMdSource[] = [];
  for (const name of CANDIDATE_NAMES) {
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (!s.isFile() || s.size > MAX_FILE_SIZE) continue;
      const content = await readFile(path, 'utf8');
      out.push({ path, scope, content, mtime: s.mtimeMs });
    } catch { /* file not found or unreadable */ }
  }
  return out;
}

/** Resolve `@path/to/file.md` imports, up to MAX_IMPORT_DEPTH levels deep. */
async function resolveImports(
  content: string,
  baseDir: string,
  depth: number,
  seen: Set<string>,
): Promise<string> {
  if (depth >= MAX_IMPORT_DEPTH) return content;
  const re = /^@([^\s]+\.md)\s*$/gm;
  const replacements: Array<{ match: string; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const target = resolve(baseDir, m[1]!);
    if (seen.has(target)) continue;
    seen.add(target);
    try {
      const raw = await readFile(target, 'utf8');
      const expanded = await resolveImports(raw, dirname(target), depth + 1, seen);
      replacements.push({ match: m[0], text: `<!-- @${m[1]} -->\n${expanded}` });
    } catch { /* missing import file — skip */ }
  }
  let result = content;
  for (const r of replacements) result = result.replace(r.match, r.text);
  return result;
}

export interface LoadedAgentMd {
  merged: string;
  sources: AgentMdSource[];
  version: string;   // mtime fingerprint for cache-busting
}

let cached: { version: string; value: LoadedAgentMd } | null = null;

export async function loadAgentMd(cwd = process.cwd()): Promise<LoadedAgentMd> {
  const sources: AgentMdSource[] = [];
  sources.push(...(await tryRead(join(homedir(), '.my-agent'), 'global')));
  const root = await findProjectRoot(cwd);
  if (root) sources.push(...(await tryRead(root, 'project')));
  if (root && root !== cwd) sources.push(...(await tryRead(cwd, 'cwd')));

  const seen = new Set<string>(sources.map(s => s.path));
  const parts: string[] = [];
  let total = 0;
  for (const src of sources) {
    const expanded = await resolveImports(src.content, dirname(src.path), 0, seen);
    const block = `<!-- ${src.scope}: ${src.path} -->\n${expanded.trim()}`;
    if (total + block.length > MAX_TOTAL_SIZE) break;
    parts.push(block);
    total += block.length;
  }

  const merged = parts.join('\n\n---\n\n');
  const version = sources.map(s => `${s.path}:${s.mtime}`).join('|') || 'none';
  return { merged, sources, version };
}

/** Cached wrapper — only re-reads files when mtime changes (bumps version). */
export async function loadAgentMdCached(cwd?: string): Promise<LoadedAgentMd> {
  const fresh = await loadAgentMd(cwd);
  if (!cached || cached.version !== fresh.version) {
    cached = { version: fresh.version, value: fresh };
  }
  return cached.value;
}

/** Invalidate the cache (e.g., after /init writes a new AGENT.md). */
export function invalidateAgentMdCache(): void {
  cached = null;
}
