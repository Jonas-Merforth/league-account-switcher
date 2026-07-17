import test from 'node:test';
import assert from 'node:assert/strict';

import { AppearOfflineState } from '../src/core/appearOfflineState.js';

test('a rejected switch attempt does not consume active Appear Offline state', () => {
  const state = new AppearOfflineState();
  state.setEnabled(true, { clientRunning: true });

  assert.throws(() => state.startSwitch(() => {
    throw new Error('switch rejected');
  }), /switch rejected/);
  assert.deepEqual(state.snapshot(), { on: true, pendingNext: false, desired: true });
});

test('starting a switch does not consume an armed account before that switch succeeds', () => {
  const state = new AppearOfflineState();
  state.setEnabled(true, { clientRunning: false });

  assert.equal(state.startSwitch(() => 'started'), 'started');
  assert.deepEqual(state.snapshot(), { on: true, pendingNext: true, desired: false });

  state.completeSuccessfulSwitch();
  assert.deepEqual(state.snapshot(), { on: true, pendingNext: false, desired: true });
});

test('a successful switch away consumes Appear Offline for the next account', () => {
  const state = new AppearOfflineState();
  state.setEnabled(true, { clientRunning: true });

  state.startSwitch(() => 'started');
  state.completeSuccessfulSwitch();
  assert.deepEqual(state.snapshot(), { on: false, pendingNext: false, desired: false });
});
