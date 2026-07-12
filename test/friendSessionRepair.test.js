import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  friendRepairRestoreOptions,
  replaceLiveSessionBundle,
  runSequentialFriendRepairs,
  shouldCountLoginDuringFriendRepair
} from '../src/core/friendSessionRepair.js';

test('repairs sequentially, continues after failures, validates successes, and restores last', async () => {
  const calls = [];
  const progress = [];
  const result = await runSequentialFriendRepairs(['a', 'b', 'a', 'c'], {
    repair: async (id) => {
      calls.push(`repair:${id}`);
      if (id === 'b') throw new Error('login failed');
      return { label: id.toUpperCase() };
    },
    validate: async (id) => {
      calls.push(`validate:${id}`);
      if (id === 'c') throw new Error('replay failed');
      return { label: id.toUpperCase(), riotId: `${id}#1` };
    },
    restore: async () => {
      calls.push('restore');
      return { restored: true, accountId: 'original' };
    },
    progress: (event) => progress.push(event.phase)
  });

  assert.deepEqual(calls, ['repair:a', 'validate:a', 'repair:b', 'repair:c', 'validate:c', 'restore']);
  assert.deepEqual(result.fixed.map((item) => item.accountId), ['a']);
  assert.deepEqual(result.failed.map((item) => item.accountId), ['b', 'c']);
  assert.equal(result.restoration.restored, true);
  assert.deepEqual(progress, ['account-start', 'account-done', 'account-start', 'account-error', 'account-start', 'account-error', 'restoring', 'repair-done']);
});

test('restores even when every repair fails and reports restoration failure', async () => {
  let restored = 0;
  const result = await runSequentialFriendRepairs(['a'], {
    repair: async () => { throw new Error('nope'); },
    validate: async () => { throw new Error('should not run'); },
    restore: async () => { restored += 1; throw new Error('restore failed'); }
  });
  assert.equal(restored, 1);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(result.restoration, { restored: false, reason: 'restore failed' });
});

test('replaceLiveSessionBundle removes stale files before restoring the exact manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'friend-repair-'));
  try {
    fs.mkdirSync(path.join(root, 'Data', 'Cookies'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Data', 'Cookies', 'stale'), 'stale');
    replaceLiveSessionBundle(root, {
      'Data/RiotGamesPrivateSettings.yaml': Buffer.from('restored').toString('base64')
    });
    assert.equal(fs.existsSync(path.join(root, 'Data', 'Cookies', 'stale')), false);
    assert.equal(fs.readFileSync(path.join(root, 'Data', 'RiotGamesPrivateSettings.yaml'), 'utf8'), 'restored');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restoration preserves whether League was running and carries an open lobby only to League', () => {
  const lobby = { partyId: 'party', open: true };
  assert.deepEqual(friendRepairRestoreOptions({ leagueWasRunning: true, lobbyRejoinTarget: lobby }), {
    force: false, forceLogin: false, clientOnly: false, repairOnly: false, lobbyRejoinTarget: lobby
  });
  assert.deepEqual(friendRepairRestoreOptions({ leagueWasRunning: false, lobbyRejoinTarget: lobby }), {
    force: false, forceLogin: false, clientOnly: true, repairOnly: true, lobbyRejoinTarget: null
  });
});

test('repair-only logins are excluded from user login statistics', () => {
  assert.equal(shouldCountLoginDuringFriendRepair(true), false);
  assert.equal(shouldCountLoginDuringFriendRepair(false), true);
});
