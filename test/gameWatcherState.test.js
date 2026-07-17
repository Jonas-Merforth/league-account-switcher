import test from 'node:test';
import assert from 'node:assert/strict';

import { gameWatcherTransition } from '../src/core/gameWatcherState.js';

test('game watcher reports confirmed game start and end edges', () => {
  assert.deepEqual(gameWatcherTransition(false, 'InProgress'), {
    known: true,
    inGame: true,
    started: true,
    ended: false
  });
  assert.deepEqual(gameWatcherTransition(true, 'WaitingForStats'), {
    known: true,
    inGame: false,
    started: false,
    ended: true
  });
});

test('an unavailable gameflow phase preserves an in-progress game instead of inventing its end', () => {
  assert.deepEqual(gameWatcherTransition(true, null), {
    known: false,
    inGame: true,
    started: false,
    ended: false
  });
  assert.deepEqual(gameWatcherTransition(true, ''), {
    known: false,
    inGame: true,
    started: false,
    ended: false
  });
});
