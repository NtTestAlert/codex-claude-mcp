import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stripAnsi, UUID_RE, isUuid, tailLines, capText, homeDir, writeFileAtomic, samePathOnDisk } from '../dist/util.js';

test('stripAnsi removes CSI, SGR and OSC sequences', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m plain'), 'red plain');
  assert.equal(stripAnsi('\u001b[1;32;40mX\u001b[K'), 'X');
  assert.equal(stripAnsi('\u001b]0;title\u0007after'), 'after');
  assert.equal(stripAnsi('\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\'), 'link');
  assert.equal(stripAnsi('no escapes'), 'no escapes');
  assert.equal(stripAnsi(''), '');
});

test('UUID helpers', () => {
  assert.ok(isUuid('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'));
  assert.ok(isUuid('0199A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B'));
  assert.ok(!isUuid('0199a1b2c3d47e5f8a9b0c1d2e3f4a5b'));
  assert.ok(!isUuid(' 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'));
  assert.ok(!isUuid('../etc/passwd'));
  assert.ok(UUID_RE.test('00000000-0000-0000-0000-000000000000'));
});

test('tailLines', () => {
  assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc');
  assert.equal(tailLines('a\r\nb\r\nc', 5), 'a\nb\nc');
  assert.equal(tailLines('', 3), '');
  assert.equal(tailLines('x', 0), '');
});

test('capText', () => {
  assert.deepEqual(capText('hello', 10), { text: 'hello', truncated: false });
  assert.deepEqual(capText('hello', 3), { text: 'hel', truncated: true });
});

test('capText never splits a surrogate pair', () => {
  const s = 'ab\u{1F600}cd'; // a b <hi lo> c d
  assert.deepEqual(capText(s, 3), { text: 'ab', truncated: true });
  assert.deepEqual(capText(s, 4), { text: 'ab\u{1F600}', truncated: true });
  assert.deepEqual(capText('\u{1F600}', 1), { text: '', truncated: true });
  assert.deepEqual(capText('abc', 0), { text: '', truncated: true });
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  for (let n = 0; n < s.length; n++) assert.ok(!lone.test(capText(s, n).text), String(n));
});

test('samePathOnDisk: lexical, case-insensitive on win32, and through links', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-codex-mcp-util-'));
  const a = path.join(dir, 'a');
  fs.mkdirSync(a);
  assert.equal(await samePathOnDisk(a, path.join(dir, 'x', '..', 'a')), true);
  assert.equal(await samePathOnDisk(a, path.join(dir, 'b')), false);
  assert.equal(await samePathOnDisk(path.join(dir, 'nope1'), path.join(dir, 'nope2')), false);
  if (process.platform === 'win32') assert.equal(await samePathOnDisk(a, a.toUpperCase()), true);
  const link = path.join(dir, 'link');
  try {
    fs.symlinkSync(a, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    return;
  }
  assert.equal(await samePathOnDisk(link, a), true);
  assert.equal(await samePathOnDisk(path.join(link, 'not-yet'), path.join(a, 'not-yet')), true);
  assert.equal(await samePathOnDisk(path.join(link, 'not-yet'), a), false);
});

test('homeDir', () => {
  assert.equal(homeDir(), os.homedir());
});

test('writeFileAtomic writes, overwrites and leaves no temp files', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-codex-mcp-util-'));
  const f = path.join(dir, 'sub', 'config.toml');
  await writeFileAtomic(f, 'one');
  assert.equal(fs.readFileSync(f, 'utf8'), 'one');
  await Promise.all([writeFileAtomic(f, 'two'), writeFileAtomic(f, 'three')]);
  assert.ok(['two', 'three'].includes(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['config.toml']);
});
