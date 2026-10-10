import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { warnIfTokenExpiringSoon } from '../src/cli/reminders.js';
import type { Settings } from '../src/config/settings.js';
import { fakeJwt } from './helpers/mock-chatgpt.js';

async function tempSettings(): Promise<Settings> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reminders-'));
  return { configDir: dir, configPath: path.join(dir, 'config.env'), stateDir: dir, env: {} };
}

test('no warning while the token has more than two days left', async () => {
  const sent: string[] = [];
  const settings = await tempSettings();
  const result = await warnIfTokenExpiringSoon(settings, fakeJwt({ expiresInSeconds: 5 * 86_400 }), (_t, m) => sent.push(m));
  assert.equal(result, null);
  assert.deepEqual(sent, []);
});

test('under two days: notifies once a day per token, and again for a new token', async () => {
  const sent: string[] = [];
  const settings = await tempSettings();
  const token = fakeJwt({ expiresInSeconds: 86_400 });

  const first = await warnIfTokenExpiringSoon(settings, token, (_t, m) => sent.push(m));
  assert.match(first ?? '', /expires in 23h 59m|expires in 1d 0h/);
  assert.match(first ?? '', /chatgpt-exporter login/);
  assert.equal(sent.length, 1);

  const second = await warnIfTokenExpiringSoon(settings, token, (_t, m) => sent.push(m));
  assert.ok(second, 'still reports the warning');
  assert.equal(sent.length, 1, 'but does not notify again the same day');

  // Pretend the last notification was 25 hours ago.
  const stampPath = path.join(settings.stateDir, 'reminder-token-expiry.json');
  const stamp = JSON.parse(await fs.readFile(stampPath, 'utf-8'));
  await fs.writeFile(stampPath, JSON.stringify({ ...stamp, notifiedAt: Date.now() - 25 * 3600_000 }));
  await warnIfTokenExpiringSoon(settings, token, (_t, m) => sent.push(m));
  assert.equal(sent.length, 2, 'repeats daily');

  await warnIfTokenExpiringSoon(settings, fakeJwt({ expiresInSeconds: 3600 }), (_t, m) => sent.push(m));
  assert.equal(sent.length, 3, 'a different token gets its own first warning');
});
