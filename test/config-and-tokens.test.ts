import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, updateEnvFile } from '../src/config/env-file.js';
import { getTokenInfo, isTokenExpired, parseCredentialsText, pickToken } from '../src/auth/tokens.js';
import { parseRetryAfter } from '../src/api/client.js';
import { fakeJwt } from './helpers/mock-chatgpt.js';

test('parseEnv handles quotes, export and comments', () => {
  const env = parseEnv(
    [
      '# comment',
      'export A=1',
      'B="two words # not a comment"',
      "C='single'",
      'D=plain # trailing comment',
      'E="esc\\"aped\\\\"',
      'bad line',
      'A=2',
    ].join('\n')
  );
  assert.deepEqual(env, { A: '2', B: 'two words # not a comment', C: 'single', D: 'plain', E: 'esc"aped\\' });
});

test('updateEnvFile keeps other lines, replaces in place, drops duplicates and is owner-only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-'));
  const file = path.join(dir, '.env');
  await fs.writeFile(file, '# keep me\nCHATGPT_TOKEN=old\nOTHER=x\nCHATGPT_TOKEN=older\nCHATGPT_ACCOUNT_ID=abc\n');
  await updateEnvFile(file, {
    CHATGPT_TOKEN: 'new.token.value',
    CHATGPT_ACCOUNT_ID: undefined,
    CHATGPT_EXPORT_DIR: '/Users/me/My Backups & Notes/chatgpt-export',
  });
  const text = await fs.readFile(file, 'utf-8');
  assert.equal(
    text,
    '# keep me\nCHATGPT_TOKEN=new.token.value\nOTHER=x\nCHATGPT_EXPORT_DIR="/Users/me/My Backups & Notes/chatgpt-export"\n'
  );
  assert.equal(parseEnv(text).CHATGPT_EXPORT_DIR, '/Users/me/My Backups & Notes/chatgpt-export');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('updateEnvFile creates a new file with a header', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-'));
  const file = path.join(dir, '.env');
  await updateEnvFile(file, { CHATGPT_TOKEN: 'abc' }, '# header\n');
  assert.equal(await fs.readFile(file, 'utf-8'), '# header\nCHATGPT_TOKEN=abc\n');
});

test('parseCredentialsText accepts everything a user might copy', () => {
  const token = fakeJwt();
  const accountId = '11111111-2222-4333-8444-555555555555';

  assert.deepEqual(parseCredentialsText(JSON.stringify({ accessToken: token, accountId })), { accessToken: token, accountId });
  assert.deepEqual(parseCredentialsText(JSON.stringify({ accessToken: token, accountId: 'personal' })), { accessToken: token, accountId: undefined });

  const sessionPage = `Pretty-print\n${JSON.stringify({ user: { id: 'u', email: 'me@example.com' }, expires: '2026-12-01', accessToken: token })}`;
  assert.equal(parseCredentialsText(sessionPage)?.accessToken, token);
  assert.equal(parseCredentialsText(`Authorization: Bearer ${token}`)?.accessToken, token);
  assert.equal(parseCredentialsText(`  ${token}\n`)?.accessToken, token);

  assert.equal(parseCredentialsText('{"user":{}}'), null, 'signed-out session page');
  assert.equal(parseCredentialsText('hello world'), null);
  assert.equal(parseCredentialsText(''), null);
});

test('token info, expiry and choosing the first unexpired token', () => {
  const live = fakeJwt({ email: 'me@example.com', accountId: '11111111-2222-4333-8444-555555555555' });
  const dead = fakeJwt({ expiresInSeconds: -60 });

  const info = getTokenInfo(live);
  assert.equal(info?.email, 'me@example.com');
  assert.equal(info?.accountId, '11111111-2222-4333-8444-555555555555');
  assert.equal(isTokenExpired(live), false);
  assert.equal(isTokenExpired(dead), true);
  assert.equal(isTokenExpired(fakeJwt({ expiresInSeconds: 30 })), true, 'within the 1-minute safety margin');

  const { chosen, expired } = pickToken([
    { token: dead, source: 'environment' },
    { token: 'not-a-jwt', source: 'flag' },
    { token: live, source: 'env-file' },
  ]);
  assert.equal(chosen?.source, 'env-file');
  assert.deepEqual(expired.map((e) => e.source), ['environment']);
});

test('parseRetryAfter reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter('1.5'), 1_500);
  const now = Date.parse('2026-10-09T05:00:00Z');
  assert.equal(parseRetryAfter('Fri, 09 Oct 2026 05:10:00 GMT', now), 600_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('soon'), undefined);
});
