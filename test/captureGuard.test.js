import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'las-capture-'));
process.env.LCA_CONFIG_DIR = tmp;

const { AccountManager } = await import('../src/core/accountManager.js');

function manager() {
  return new AccountManager({ riotClient: {}, lcuClient: {}, log: () => {} });
}

test('_identityMismatch only flags a different name for previously-captured accounts', () => {
  const m = manager();
  // Never captured -> can't compare -> not a mismatch (don't block a first capture).
  assert.equal(m._identityMismatch({ lastSummonerName: null }, 'Whoever'), false);
  assert.equal(m._identityMismatch({ lastSummonerName: '' }, 'Whoever'), false);
  // Captured before, same name (case-insensitive / trimmed) -> ok.
  assert.equal(m._identityMismatch({ lastSummonerName: 'Faker' }, '  faker '), false);
  // Captured before, a different account signed in -> mismatch.
  assert.equal(m._identityMismatch({ lastSummonerName: 'Faker' }, 'HideOnBush'), true);
  // Older stored data sometimes used the login username as lastSummonerName; don't block the
  // first capture after the app starts storing the actual in-game name.
  assert.equal(m._identityMismatch({ username: 'legacy_login', lastSummonerName: 'legacy_login' }, 'In Game'), false);
  // Unknown signed-in name -> not flagged (handled by the caller via the `name &&` guard).
  assert.equal(m._identityMismatch({ lastSummonerName: 'Faker' }, ''), true);
});

test('stale switch runs cannot overwrite a restarted switch status', () => {
  const m = manager();
  m._activeSwitch = { id: 'new-run', options: {}, runId: 2 };
  m.switchStatus = {
    busy: true,
    id: 'new-run',
    label: 'Retry Target',
    stage: 'logging-in',
    message: 'Retrying login typing',
    error: null,
    startedAt: '2026-07-05T00:00:00.000Z',
    finishedAt: null
  };

  assert.equal(m._setStage('done', 'Old run stage', 1), false);
  assert.equal(m._finishSwitch('Old run finished', 1), false);
  assert.equal(m._failSwitch('Old run failed', 1), false);

  assert.equal(m.switchStatus.busy, true);
  assert.equal(m.switchStatus.stage, 'logging-in');
  assert.equal(m.switchStatus.message, 'Retrying login typing');
  assert.equal(m._activeSwitch.runId, 2);
});
