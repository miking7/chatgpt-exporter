import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeJwt, makeConversations, startMockServer } from './helpers/mock-chatgpt.js';

// Runs the CLI in a real pseudo-terminal, because spinners change terminal modes:
// ora's default (discardStdin) used to swallow Ctrl+C for the whole listing.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasPython = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;

test('Ctrl+C typed in a terminal during the listing stops the backup gracefully', { skip: !hasPython && 'needs python3' }, async () => {
  const token = fakeJwt();
  const mock = await startMockServer({ token, conversations: makeConversations(1000), listDelayMs: 3_000 });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tty-'));
  try {
    await fs.writeFile(path.join(home, '.env'), `CHATGPT_TOKEN=${token}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CHATGPT_EXPORTER_HOME: home,
      CHATGPT_BASE_URL: mock.url,
      CHATGPT_EXPORT_DIR: path.join(home, 'out'),
    };
    delete env.CHATGPT_TOKEN;
    const child = spawn(
      'python3',
      ['-I', path.join(root, 'test/helpers/pty_run.py'), process.execPath, '--import', 'tsx', path.join(root, 'src/index.ts'), 'backup', '--no-keep-awake'],
      { cwd: root, env }
    );
    let output = '';
    child.stdout.on('data', (d) => (output += d));

    // Wait until the listing spinner is showing, then press Ctrl+C.
    const deadline = Date.now() + 20_000;
    while (!output.includes('Listing') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(output.includes('Listing'), 'listing started');
    const pressedAt = Date.now();
    child.stdin.write('\x03');

    const code = await new Promise<number | null>((resolve) => {
      const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.on('close', (c) => {
        clearTimeout(killer);
        resolve(c);
      });
    });
    assert.ok(Date.now() - pressedAt < 5_000, `took ${Date.now() - pressedAt} ms to stop`);
    assert.equal(code, 130);
    assert.match(output, /Stopping after the current step/);
    assert.match(output, /Backup paused/);
  } finally {
    await mock.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});
