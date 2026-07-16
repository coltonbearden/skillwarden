import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixturePath(name) {
  return path.join(FIXTURES, name);
}
export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(fixturePath(name), 'utf-8'));
}
export function loadFixtureRaw(name) {
  return fs.readFileSync(fixturePath(name), 'utf-8');
}
export function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `skillwarden-${prefix}-`));
}
export function rmTemp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
