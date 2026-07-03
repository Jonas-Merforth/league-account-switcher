import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeSessionAge,
  hasPersistedSession,
  normalizeAccount,
  normalizeAccounts,
  normalizeRanks,
  redactAccount
} from '../src/core/accountStore.js';

test('normalizeAccount fills defaults and keeps an id stable', () => {
  const account = normalizeAccount({ id: 'abc', username: '  smurf  ', passwordEnc: 'enc', region: ' euw ' });
  assert.equal(account.id, 'abc');
  assert.equal(account.username, 'smurf');
  assert.equal(account.label, 'smurf'); // label falls back to username
  assert.equal(account.passwordEnc, 'enc');
  assert.equal(account.region, 'euw');
  assert.equal(account.lastSummonerName, null);
  assert.equal(account.sessionCapturedAt, null);
});

test('normalizeAccount generates an id when missing and prefers an explicit label', () => {
  const account = normalizeAccount({ label: 'Main', username: 'main_login' });
  assert.equal(account.label, 'Main');
  assert.match(account.id, /[0-9a-f-]{36}/);
});

test('normalizeAccounts maps a list and tolerates non-arrays', () => {
  assert.deepEqual(normalizeAccounts(null), []);
  const list = normalizeAccounts([{ username: 'a' }, { username: 'b' }]);
  assert.equal(list.length, 2);
  assert.equal(list[0].username, 'a');
});

test('redactAccount never exposes the encrypted password', () => {
  const view = redactAccount(normalizeAccount({ username: 'u', passwordEnc: 'SECRET' }));
  assert.equal(view.hasPassword, true);
  assert.equal('passwordEnc' in view, false);

  const noPass = redactAccount(normalizeAccount({ username: 'u' }));
  assert.equal(noPass.hasPassword, false);
});

test('normalizeAccount defaults ranks to null and preserves valid ones', () => {
  assert.equal(normalizeAccount({ username: 'u' }).ranks, null);

  const ranks = {
    solo: { tier: 'gold', division: 3, lp: 85, wins: 18, losses: 21 },
    flex: null,
    updatedAt: '2026-07-03T00:00:00Z'
  };
  const account = normalizeAccount({ username: 'u', ranks });
  assert.deepEqual(account.ranks.solo, { tier: 'GOLD', division: 3, lp: 85, wins: 18, losses: 21 });
  assert.equal(account.ranks.flex, null);
  assert.equal(account.ranks.updatedAt, '2026-07-03T00:00:00Z');
});

test('normalizeRanks drops garbage and non-integer divisions', () => {
  assert.equal(normalizeRanks(null), null);
  assert.equal(normalizeRanks('gold'), null);
  const ranks = normalizeRanks({ solo: { tier: 'MASTER', division: 'NA', lp: '245' }, flex: { division: 2 } });
  assert.deepEqual(ranks.solo, { tier: 'MASTER', division: null, lp: 245, wins: 0, losses: 0 });
  assert.equal(ranks.flex, null); // no tier -> not a rank
  assert.equal(ranks.updatedAt, null);
});

test('redactAccount passes ranks through to the renderer view', () => {
  const account = normalizeAccount({
    username: 'u',
    ranks: { solo: { tier: 'IRON', division: 4, lp: 1, wins: 2, losses: 3 }, flex: null }
  });
  assert.deepEqual(redactAccount(account).ranks, account.ranks);
});

test('hasPersistedSession distinguishes a remembered login from a signed-out file', () => {
  assert.equal(hasPersistedSession('riot-login:\n    persist: null'), false);
  assert.equal(hasPersistedSession(''), false);
  assert.equal(hasPersistedSession('persist:\n  session:\n    cookies:\n    - name: "ssid"'), true);
  assert.equal(hasPersistedSession('persist:\n  cookies:\n  - name: other'), true);
});

test('describeSessionAge flags stale sessions past two weeks', () => {
  const now = new Date('2026-06-21T00:00:00Z');
  assert.equal(describeSessionAge(null, now).captured, false);

  const fresh = describeSessionAge('2026-06-20T00:00:00Z', now);
  assert.equal(fresh.captured, true);
  assert.equal(fresh.days, 1);
  assert.equal(fresh.stale, false);

  const stale = describeSessionAge('2026-06-01T00:00:00Z', now);
  assert.equal(stale.days, 20);
  assert.equal(stale.stale, true);
});
