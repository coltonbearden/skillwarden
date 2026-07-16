import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorEnabled,
  colorizer,
  renderTable,
  truncate,
  visibleLength,
} from '../../src/output/format.ts';

test('colorizer disabled returns input unchanged', () => {
  const c = colorizer(false);
  assert.equal(c.red('x'), 'x');
  assert.equal(c.bold('x'), 'x');
});

test('colorizer enabled wraps with ANSI and visibleLength ignores it', () => {
  const c = colorizer(true);
  const red = c.red('abc');
  assert.notEqual(red, 'abc');
  assert.ok(red.includes('abc'));
  assert.equal(visibleLength(red), 3);
});

test('colorEnabled: flag beats everything', () => {
  assert.equal(colorEnabled(true, {}, true), false);
});

test('colorEnabled: NO_COLOR env disables', () => {
  assert.equal(colorEnabled(false, { NO_COLOR: '1' }, true), false);
  assert.equal(colorEnabled(false, { NO_COLOR: '' }, true), true);
});

test('colorEnabled: non-TTY disables', () => {
  assert.equal(colorEnabled(false, {}, false), false);
  assert.equal(colorEnabled(false, {}, true), true);
});

test('renderTable aligns columns and trims trailing space', () => {
  const lines = renderTable(
    ['id', 'status'],
    [
      ['a/b/c', 'ok'],
      ['x', 'modified'],
    ],
  );
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'id     status');
  assert.equal(lines[2], 'a/b/c  ok');
  assert.equal(lines[3], 'x      modified');
  for (const l of lines) assert.equal(l, l.trimEnd());
});

test('renderTable aligns colored cells by visible width', () => {
  const c = colorizer(true);
  const lines = renderTable(['s'], [[c.green('ok')], ['longer']]);
  assert.ok(lines[2]!.endsWith('m') || lines[2]!.trimEnd().endsWith('m'));
  assert.equal(visibleLength(lines[3]!), 6);
});

test('truncate cuts long strings with ellipsis', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 6), 'hello…');
});
