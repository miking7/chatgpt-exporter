import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKDOWN_FORMAT } from '../src/services/storage-service.js';
import { fakeJwt, makeConversations, startMockServer } from './helpers/mock-chatgpt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, NO_COLOR: '1' };
  delete childEnv.CHATGPT_TOKEN;
  delete childEnv.CHATGPT_ACCOUNT_ID;
  delete childEnv.CHATGPT_EXPORT_DIR;
  delete childEnv.CHATGPT_TIMEZONE;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src/index.ts'), ...args], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI: unattended backup without a token exits 2 and says to log in', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-home-'));
  try {
    const result = await runCli(['backup', '--no-keep-awake', '-o', path.join(home, 'out')], { CHATGPT_EXPORTER_HOME: home });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /No ChatGPT token is saved yet/);
    assert.match(result.stderr, /login/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('CLI: a fresh user with nothing configured gets ~/Documents/chatgpt-export, saved for later runs', { skip: process.platform === 'win32' }, async () => {
  const token = fakeJwt();
  const mock = await startMockServer({ token, conversations: makeConversations(2) });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-home-'));
  try {
    await fs.mkdir(path.join(home, 'Documents'));
    await fs.mkdir(path.join(home, '.config', 'chatgpt-exporter'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'chatgpt-exporter', 'config.env'), `CHATGPT_TOKEN=${token}\n`);
    // HOME decides both the config folder (~/.config) and the default archive folder; no overrides set.
    const env = { HOME: home, XDG_CONFIG_HOME: '', CHATGPT_EXPORTER_HOME: '', CHATGPT_BASE_URL: mock.url };

    const backup = await runCli(['backup', '--pace', '0.05', '--no-keep-awake'], env);
    assert.equal(backup.code, 0, backup.stderr + backup.stdout);
    const archive = path.join(home, 'Documents', 'chatgpt-export');
    assert.equal((await fs.readdir(path.join(archive, 'markdown'))).filter((f) => f.endsWith('.md')).length, 2);
    const config = await fs.readFile(path.join(home, '.config', 'chatgpt-exporter', 'config.env'), 'utf-8');
    assert.match(config, new RegExp(`CHATGPT_EXPORT_DIR=${archive}`), 'default saved so later runs stay put');
    assert.match(config, /^CHATGPT_TOKEN=/m, 'token kept');
    assert.match(backup.stdout, /Archive folder saved to/);

    const status = await runCli(['status'], env);
    assert.match(status.stdout, new RegExp(`Output +${archive}\\s*$`, 'm'), 'no longer marked as default');
  } finally {
    await mock.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('CLI: backup reads token and output folder from config.env, then status summarises it', async () => {
  const token = fakeJwt({ email: 'me@example.com' });
  const mock = await startMockServer({ token, conversations: makeConversations(4) });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-home-'));
  const out = path.join(home, 'my export');
  try {
    await fs.writeFile(path.join(home, 'config.env'), `CHATGPT_TOKEN=${token}\nCHATGPT_EXPORT_DIR="${out}"\n`);
    const env = { CHATGPT_EXPORTER_HOME: home, CHATGPT_BASE_URL: mock.url };

    const backup = await runCli(['backup', '--pace', '0.05', '--burst', '10', '--no-keep-awake'], env);
    assert.equal(backup.code, 0, backup.stderr + backup.stdout);
    assert.match(backup.stdout, /Backup finished/);
    const files = await fs.readdir(path.join(out, 'conversations'));
    assert.equal(files.filter((f) => f.endsWith('.json') && f !== 'index.json').length, 4);
    assert.equal((await fs.readdir(path.join(out, 'markdown'))).filter((f) => f.endsWith('.md')).length, 4);

    const metadata = JSON.parse(await fs.readFile(path.join(out, 'metadata.json'), 'utf-8'));
    assert.equal(metadata.mode, 'incremental');
    assert.equal(metadata.successfulDownloads, 4);
    assert.equal(metadata.markdownFormat, MARKDOWN_FORMAT);
    assert.match(await fs.readFile(path.join(out, 'backup.log'), 'utf-8'), /Backup finished: 4 downloaded/);
    assert.match(await fs.readFile(path.join(home, 'config.env'), 'utf-8'), /^CHATGPT_TIMEZONE=\S+$/m, 'time zone pinned on the first run');

    const convert = await runCli(['convert'], env);
    assert.equal(convert.code, 0, convert.stderr);
    assert.match(convert.stdout, /Converted 4 conversations .*: 0 Markdown files rewritten, 4 already current/);

    const again = await runCli(['backup', '--pace', '0.05', '--no-keep-awake'], env);
    assert.equal(again.code, 0);
    assert.match(again.stderr, /nothing new to download/);

    const status = await runCli(['status'], env);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /4 of 4 conversations downloaded \(100%\)/);
    assert.match(status.stdout, /me@example\.com/);
    assert.match(status.stdout, /Time zone +\S+\s*$/m);
    assert.equal(mock.count((r) => r.path.startsWith('/backend-api/conversation/')), 4, 'status made no requests');

    // As if an earlier version made the archive: Markdown beside the JSON, no format recorded, a temp file from a killed run.
    const markdownDir = path.join(out, 'markdown');
    const [firstMd] = (await fs.readdir(markdownDir)).filter((f) => f.endsWith('.md'));
    const firstId = /^id: (\S+)$/m.exec(await fs.readFile(path.join(markdownDir, firstMd), 'utf-8'))![1];
    await fs.rename(path.join(markdownDir, firstMd), path.join(out, 'conversations', `${firstId}.md`));
    const { markdownFormat: _, ...older } = JSON.parse(await fs.readFile(path.join(out, 'metadata.json'), 'utf-8'));
    await fs.writeFile(path.join(out, 'metadata.json'), JSON.stringify(older));
    await fs.writeFile(path.join(out, '.sync-state.json.99999999.tmp'), '');
    const upgraded = await runCli(['backup', '--pace', '0.05', '--no-keep-awake'], env);
    assert.equal(upgraded.code, 0, upgraded.stderr);
    assert.match(upgraded.stderr, /Markdown files updated: 1 rewritten, 3 already current/);
    await fs.access(path.join(markdownDir, firstMd));
    await assert.rejects(fs.access(path.join(out, 'conversations', `${firstId}.md`)), 'the copy beside the JSON is gone');
    await assert.rejects(fs.access(path.join(out, '.sync-state.json.99999999.tmp')), 'temp file from a killed run removed');
    assert.equal(mock.count((r) => r.path.startsWith('/backend-api/conversation/')), 4, 'nothing re-downloaded');
  } finally {
    await mock.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('CLI: an expired saved token is reported instead of used', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-home-'));
  try {
    await fs.writeFile(path.join(home, 'config.env'), `CHATGPT_TOKEN=${fakeJwt({ expiresInSeconds: -3600 })}\n`);
    const result = await runCli(['backup', '--no-keep-awake', '-o', path.join(home, 'out')], { CHATGPT_EXPORTER_HOME: home });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /expired on/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('CLI: convert refuses to run alongside a backup', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-home-'));
  try {
    // This test process stands in for a running backup.
    await fs.writeFile(path.join(home, 'backup.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const result = await runCli(['convert', '-o', path.join(home, 'out')], { CHATGPT_EXPORTER_HOME: home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Another backup is already running/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
