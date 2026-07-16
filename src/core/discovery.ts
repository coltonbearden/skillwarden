import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { samePath } from '../util/paths.ts';

export interface Fingerprint {
  /** posix-relative path -> sha256 hex of CRLF-normalized content */
  files: Record<string, string>;
  /** sha256 of "<path>\0<hex>\n" lines sorted by path */
  combined: string;
}

export interface LocalSkill {
  slug: string;
  /** Directory as found (may be a symlink/junction), absolute. */
  dir: string;
  /** Resolved real directory, absolute. */
  realDir: string;
  /** Other locations that resolved to the same real directory. */
  aliases: string[];
  fingerprint: Fingerprint;
  frontmatter: { name?: string; description?: string };
  /** True when some file could not be read; fingerprint is then unreliable. */
  unreadable: boolean;
}

const EXCLUDED_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);

/** Default scan roots: project-level (cwd) plus global agent directories. */
export function defaultRoots(cwd: string, home: string): string[] {
  return [
    path.join(cwd, '.claude', 'skills'),
    path.join(cwd, '.agents', 'skills'),
    path.join(cwd, 'skills'),
    path.join(cwd, 'skills', '.curated'),
    path.join(cwd, 'skills', '.experimental'),
    path.join(cwd, 'skills', '.system'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.cursor', 'skills'),
    path.join(home, '.codex', 'skills'),
  ];
}

/** Strip a UTF-8 BOM and normalize CRLF to LF (see D-07). */
function normalizeContent(buf: Buffer): Buffer {
  let s = buf.toString('utf-8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return Buffer.from(s.replaceAll('\r\n', '\n'), 'utf-8');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Digest of an already-normalized content string (used when pinning registry files[]). */
export function digestContent(contents: string): string {
  return sha256Hex(normalizeContent(Buffer.from(contents, 'utf-8')));
}

export function combineDigests(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${p}\0${files[p]}\n`)
    .join('');
  return sha256Hex(lines);
}

async function listFilesRecursive(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (EXCLUDED_NAMES.has(e.name)) continue;
    const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(full, relPath)));
    } else if (e.isFile() || e.isSymbolicLink()) {
      out.push(relPath);
    }
  }
  return out;
}

export async function fingerprintDir(
  dir: string,
): Promise<{ fingerprint: Fingerprint; unreadable: boolean }> {
  const files: Record<string, string> = {};
  let unreadable = false;
  for (const relPath of await listFilesRecursive(dir)) {
    try {
      const buf = await fs.readFile(path.join(dir, ...relPath.split('/')));
      files[relPath] = sha256Hex(normalizeContent(buf));
    } catch {
      unreadable = true;
    }
  }
  return { fingerprint: { files, combined: combineDigests(files) }, unreadable };
}

/** Minimal frontmatter extraction: a leading `--- ... ---` block with `key: value` lines. */
export function parseFrontmatter(skillMd: string): { name?: string; description?: string } {
  let s = skillMd;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(s);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.+)$/.exec(line);
    if (kv) {
      const value = kv[2]!.trim().replace(/^['"]|['"]$/g, '');
      if (kv[1] === 'name') out.name = value;
      else out.description = value;
    }
  }
  return out;
}

async function tryRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Discover skills (directories directly containing SKILL.md) under the given roots.
 * Nonexistent roots are skipped. Symlinked/junctioned duplicates collapse into one
 * entry with `aliases`. Results sorted by slug, then dir.
 */
export async function discoverSkills(
  roots: string[],
  platform: NodeJS.Platform = os.platform(),
): Promise<LocalSkill[]> {
  const found: LocalSkill[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue; // root does not exist
    }
    for (const e of entries) {
      if (EXCLUDED_NAMES.has(e.name) || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = (await fs.stat(dir)).isDirectory();
        } catch {
          continue; // dangling link
        }
      }
      if (!isDir) continue;
      const skillMdPath = path.join(dir, 'SKILL.md');
      let skillMd: string;
      try {
        skillMd = await fs.readFile(skillMdPath, 'utf-8');
      } catch {
        continue; // not a skill dir
      }
      const realDir = await tryRealpath(dir);
      const existing = found.find((s) => samePath(s.realDir, realDir, platform));
      if (existing) {
        existing.aliases.push(dir);
        continue;
      }
      const { fingerprint, unreadable } = await fingerprintDir(dir);
      found.push({
        slug: e.name,
        dir,
        realDir,
        aliases: [],
        fingerprint,
        frontmatter: parseFrontmatter(skillMd),
        unreadable,
      });
    }
  }
  return found.sort((a, b) => a.slug.localeCompare(b.slug) || a.dir.localeCompare(b.dir));
}
