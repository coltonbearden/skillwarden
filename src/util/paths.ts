import path from 'node:path';

/**
 * Resolve the response-cache directory. Precedence: SKILLWARDEN_CACHE_DIR env override,
 * then the platform convention (see docs/PRD.md, R-04).
 */
export function cacheDir(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home: string,
): string {
  const override = env['SKILLWARDEN_CACHE_DIR'];
  if (override !== undefined && override !== '') return override;
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
    return path.join(base, 'skillwarden', 'cache');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Caches', 'skillwarden');
  }
  const xdg = env['XDG_CACHE_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(home, '.cache');
  return path.join(base, 'skillwarden');
}

/** Relative path from `from` to `to`, always with forward slashes (lockfile format). */
export function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

/** Path equality; case-insensitive on Windows. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (platform === 'win32') return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}
