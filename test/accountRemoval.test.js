import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'las-account-remove-'));
process.env.LCA_CONFIG_DIR = tmp;

const { AccountManager } = await import('../src/core/accountManager.js');
const { getAccountsPath } = await import('../src/core/config.js');
const { hasSnapshot, normalizeAccount, writeSnapshot } = await import('../src/core/accountStore.js');

test('a failed account metadata write does not delete its saved session or in-memory account', () => {
  const manager = new AccountManager({ riotClient: {}, lcuClient: {}, log: () => {} });
  manager.accounts = [normalizeAccount({ id: 'keep-me', label: 'Keep me' })];
  writeSnapshot('keep-me', 'encrypted-session');

  // A directory at the metadata-file path deterministically makes writeFileSync fail with EISDIR.
  fs.mkdirSync(getAccountsPath(), { recursive: true });

  assert.throws(() => manager.remove('keep-me'));
  assert.equal(hasSnapshot('keep-me'), true);
  assert.deepEqual(manager.accounts.map((account) => account.id), ['keep-me']);
});
