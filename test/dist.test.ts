import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// dist/index.js is committed so `npx github:…` and `npm install -g github:…` need no build step
// (npm's global install of a git package can't run a prepare script). This catches a stale commit.
test('committed dist/index.js matches a fresh build of src/ (run `npm run build` if this fails)', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'dist-'));
  try {
    const build = spawnSync('npx', ['tsup', 'src/index.ts', '--format', 'esm', '--out-dir', out], { cwd: root, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const fresh = await fs.readFile(path.join(out, 'index.js'), 'utf8');
    const committed = await fs.readFile(path.join(root, 'dist', 'index.js'), 'utf8');
    assert.equal(committed, fresh, 'dist/index.js is out of date: run `npm run build` and commit it');
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});
