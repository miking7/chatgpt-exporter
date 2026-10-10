import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configDir, defaultOutputDir, expandHome, loadSettings, resolveOutputDir, saveSettings } from '../src/config/settings.js';

/** Runs fn with these environment variables set (undefined = unset), then restores the originals. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('config lives in a per-user folder, not next to the package or the current directory', { skip: process.platform === 'win32' }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'));
  await withEnv({ HOME: home, XDG_CONFIG_HOME: undefined, CHATGPT_EXPORTER_HOME: undefined }, () => {
    assert.equal(configDir(), path.join(home, '.config', 'chatgpt-exporter'));
  });
  await withEnv({ HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), CHATGPT_EXPORTER_HOME: undefined }, () => {
    assert.equal(configDir(), path.join(home, 'xdg', 'chatgpt-exporter'));
  });
  await withEnv({ HOME: home, CHATGPT_EXPORTER_HOME: '~/work-account' }, () => {
    assert.equal(configDir(), path.join(home, 'work-account'), 'override, with ~ expanded');
  });
  await fs.rm(home, { recursive: true, force: true });
});

test('the default archive folder is ~/Documents/chatgpt-export, or ~/chatgpt-export without a Documents folder', { skip: process.platform === 'win32' }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'));
  await withEnv({ HOME: home }, async () => {
    assert.equal(defaultOutputDir(), path.join(home, 'chatgpt-export'));
    await fs.mkdir(path.join(home, 'Documents'));
    assert.equal(defaultOutputDir(), path.join(home, 'Documents', 'chatgpt-export'));
    assert.equal(expandHome('~/x/y'), path.join(home, 'x/y'));
    assert.equal(expandHome('/abs'), '/abs');
  });
  await fs.rm(home, { recursive: true, force: true });
});

test('settings round-trip through config.env, and -o beats the configured folder', { skip: process.platform === 'win32' }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'));
  await withEnv({ HOME: home, XDG_CONFIG_HOME: undefined, CHATGPT_EXPORTER_HOME: undefined, CHATGPT_EXPORT_DIR: undefined }, async () => {
    const settings = await loadSettings();
    assert.equal(settings.configPath, path.join(home, '.config', 'chatgpt-exporter', 'config.env'));
    assert.deepEqual(settings.env, {});
    assert.equal(resolveOutputDir(settings), path.join(home, 'chatgpt-export'), 'default before anything is saved');

    await saveSettings(settings, { CHATGPT_EXPORT_DIR: '~/My Archive' });
    const text = await fs.readFile(settings.configPath, 'utf-8');
    assert.match(text, /^# chatgpt-exporter settings/, 'new file starts with the documented header');
    assert.match(text, /CHATGPT_EXPORT_DIR="~\/My Archive"/);
    assert.equal((await fs.stat(settings.configPath)).mode & 0o777, 0o600);

    const reloaded = await loadSettings();
    assert.equal(resolveOutputDir(reloaded), path.join(home, 'My Archive'));
    assert.equal(resolveOutputDir(reloaded, 'elsewhere'), path.resolve('elsewhere'));
  });
  await fs.rm(home, { recursive: true, force: true });
});
