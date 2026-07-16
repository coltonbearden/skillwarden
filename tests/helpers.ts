import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export { fixturePath, loadFixture, loadFixtureRaw, makeTemp, rmTemp } from './helpers.mjs';

/** Write a skill directory: root/<slug>/SKILL.md (+ extra files). */
export function writeSkill(
  root: string,
  slug: string,
  skillMd: string,
  extraFiles: Record<string, string> = {},
): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd);
  for (const [rel, contents] of Object.entries(extraFiles)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
  return dir;
}

/** Directory link that works without privileges on Windows (junction) and elsewhere (symlink). */
export function linkDir(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const type = os.platform() === 'win32' ? 'junction' : undefined;
  fs.symlinkSync(target, linkPath, type);
}

/** A fake sleep that records requested delays and resolves immediately. */
export function fakeSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}
