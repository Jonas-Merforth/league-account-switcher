import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accountStatsSummary,
  incrementLoginCount,
  loadAccountStats,
  LoginObservationTracker,
  normalizeAccountStats,
  recordStartedGame,
  removeAccountStatistics,
  saveAccountStats
} from '../src/core/accountStats.js';

test('normalizeAccountStats repairs invalid counters and queue records', () => {
  assert.deepEqual(normalizeAccountStats({ accounts: {
    a: {
      loginCount: '3.9',
      gamesByQueue: {
        'id:420': { label: 'Ranked Solo', count: '2' },
        empty: { label: 'Empty', count: 0 }
      },
      lastCountedGameId: 123
    }
  } }), {
    version: 1,
    accounts: {
      a: {
        loginCount: 3,
        gamesByQueue: {
          'id:420': {
            label: 'Ranked Solo', count: 2, queueId: null, type: null, gameMode: null
          }
        },
        lastCountedGameId: '123'
      }
    }
  });
});

test('login observations deduplicate polls and reset after sign-out', () => {
  const tracker = new LoginObservationTracker();
  assert.equal(tracker.observe('a'), true);
  assert.equal(tracker.observe('a'), false);
  assert.equal(tracker.observe(null), false);
  assert.equal(tracker.observe('a'), true);
  assert.equal(tracker.observe('a', { force: true }), true); // same-account re-login

  let stats = normalizeAccountStats();
  stats = incrementLoginCount(stats, 'a').stats;
  stats = incrementLoginCount(stats, 'a').stats;
  assert.equal(stats.accounts.a.loginCount, 2);
});

test('recordStartedGame groups queues and deduplicates a game across reloads', () => {
  let stats = normalizeAccountStats();
  let result = recordStartedGame(stats, 'a', { gameId: 'game-1', queue: { id: 420 } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.queue, {
    key: 'id:420', label: 'Ranked Solo', queueId: 420, type: null, gameMode: null
  });
  stats = result.stats;

  result = recordStartedGame(stats, 'a', { gameId: 'game-1', queue: { id: 420 } });
  assert.equal(result.duplicate, true);
  assert.equal(result.stats.accounts.a.gamesByQueue['id:420'].count, 1);

  result = recordStartedGame(stats, 'a', { gameId: 'game-2', queue: { type: 'NEW_ROTATING_MODE' } });
  assert.equal(result.changed, true);
  assert.equal(result.queue.label, 'New Rotating Mode');

  result = recordStartedGame(result.stats, 'a', {
    gameId: 'game-3', queue: { id: 2400, type: 'KIWI', gameMode: 'KIWI' }
  });
  assert.equal(result.queue.label, 'ARAM Mayhem');
  assert.deepEqual(
    result.stats.accounts.a.gamesByQueue['id:2400'],
    { label: 'ARAM Mayhem', count: 1, queueId: 2400, type: 'KIWI', gameMode: 'KIWI' }
  );
});

test('statistics summaries include zero accounts, layout order, totals, and sorted queues', () => {
  let stats = normalizeAccountStats();
  stats = incrementLoginCount(stats, 'b').stats;
  stats = recordStartedGame(stats, 'b', { gameId: '1', queue: { id: 450 } }).stats;
  stats = recordStartedGame(stats, 'b', { gameId: '2', queue: { id: 450 } }).stats;
  stats = recordStartedGame(stats, 'b', { gameId: '3', queue: { id: 420 } }).stats;
  const summary = accountStatsSummary(stats, [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' }
  ], ['b', 'a']);
  assert.deepEqual(summary.accounts.map((account) => account.accountId), ['b', 'a']);
  assert.equal(summary.accounts[0].totalGames, 3);
  assert.deepEqual(summary.accounts[0].queues.map((queue) => queue.label), ['ARAM', 'Ranked Solo']);
  assert.equal(summary.accounts[1].loginCount, 0);
  assert.equal(summary.accounts[1].totalGames, 0);
});

test('statistics summaries order by games then use account layout for ties including zero', () => {
  let stats = normalizeAccountStats();
  stats = recordStartedGame(stats, 'c', { gameId: 'c1', queue: { id: 420 } }).stats;
  stats = recordStartedGame(stats, 'b', { gameId: 'b1', queue: { id: 450 } }).stats;
  stats = recordStartedGame(stats, 'd', { gameId: 'd1', queue: { id: 440 } }).stats;
  stats = recordStartedGame(stats, 'd', { gameId: 'd2', queue: { id: 440 } }).stats;
  const summary = accountStatsSummary(stats, [
    { id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Charlie' }, { id: 'd', label: 'Delta' },
    { id: 'e', label: 'Echo' }
  ], ['c', 'b', 'a', 'e', 'd']);
  assert.deepEqual(
    summary.accounts.map((account) => [account.accountId, account.totalGames]),
    [['d', 2], ['c', 1], ['b', 1], ['a', 0], ['e', 0]]
  );
});

test('removeAccountStatistics drops orphaned records', () => {
  const stats = incrementLoginCount(normalizeAccountStats(), 'gone').stats;
  const result = removeAccountStatistics(stats, 'gone');
  assert.equal(result.changed, true);
  assert.equal(result.stats.accounts.gone, undefined);
});

test('file storage recovers from malformed JSON and saves normalized data', () => {
  const old = process.env.LCA_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'las-stats-'));
  process.env.LCA_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'switcher-stats.json'), '{bad json', 'utf8');
    const warnings = [];
    assert.deepEqual(loadAccountStats({ log: (message) => warnings.push(message) }), { version: 1, accounts: {} });
    assert.equal(warnings.length, 1);
    const saved = saveAccountStats({ accounts: { a: { loginCount: 2 } } });
    assert.equal(saved.accounts.a.loginCount, 2);
    assert.deepEqual(loadAccountStats(), saved);
  } finally {
    if (old === undefined) delete process.env.LCA_CONFIG_DIR;
    else process.env.LCA_CONFIG_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
