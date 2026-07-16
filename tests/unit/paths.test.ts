import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cacheDir, samePath, toPosixRelative } from '../../src/util/paths.ts';

test('cacheDir: env override wins on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.equal(
      cacheDir({ SKILLWARDEN_CACHE_DIR: '/custom/cache' }, platform, '/home/u'),
      '/custom/cache',
    );
  }
});

test('cacheDir: win32 uses LOCALAPPDATA', () => {
  const dir = cacheDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u');
  assert.equal(dir, path.join('C:\\Users\\u\\AppData\\Local', 'skillwarden', 'cache'));
});

test('cacheDir: win32 falls back to home when LOCALAPPDATA missing', () => {
  const dir = cacheDir({}, 'win32', 'C:\\Users\\u');
  assert.equal(dir, path.join('C:\\Users\\u', 'AppData', 'Local', 'skillwarden', 'cache'));
});

test('cacheDir: darwin uses Library/Caches', () => {
  assert.equal(
    cacheDir({}, 'darwin', '/Users/u'),
    path.join('/Users/u', 'Library', 'Caches', 'skillwarden'),
  );
});

test('cacheDir: linux honors XDG_CACHE_HOME, else ~/.cache', () => {
  assert.equal(
    cacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/u'),
    path.join('/xdg', 'skillwarden'),
  );
  assert.equal(cacheDir({}, 'linux', '/home/u'), path.join('/home/u', '.cache', 'skillwarden'));
});

test('toPosixRelative always uses forward slashes', () => {
  const rel = toPosixRelative(path.join('a', 'b'), path.join('a', 'b', 'c', 'd'));
  assert.equal(rel, 'c/d');
});

test('samePath is case-insensitive only on win32', () => {
  assert.equal(samePath('/A/B', '/a/b', 'win32'), true);
  assert.equal(samePath('/A/B', '/a/b', 'linux'), false);
  assert.equal(samePath('/a/b', '/a/b', 'linux'), true);
});
