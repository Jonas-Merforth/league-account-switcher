import test from 'node:test';
import assert from 'node:assert/strict';
import { canRestartSwitchStatus, retryLoginTypingView } from '../src/core/switchRetry.js';

test('canRestartSwitchStatus only allows busy login-related stages', () => {
  for (const stage of ['waiting-login', 'logging-in', 'solve-captcha', 'manual']) {
    assert.equal(canRestartSwitchStatus({ busy: true, id: 'acc-1', stage }), true, stage);
  }

  for (const stage of ['starting', 'restarting', 'closing', 'restoring', 'launching', 'launching-league', 'done', 'error']) {
    assert.equal(canRestartSwitchStatus({ busy: true, id: 'acc-1', stage }), false, stage);
  }

  assert.equal(canRestartSwitchStatus({ busy: false, id: 'acc-1', stage: 'logging-in' }), false);
  assert.equal(canRestartSwitchStatus({ busy: true, id: '', stage: 'logging-in' }), false);
});

test('retryLoginTypingView shapes the status-panel action', () => {
  assert.deepEqual(
    retryLoginTypingView({ busy: false, id: 'acc-1', stage: 'logging-in' }),
    { visible: false }
  );

  assert.deepEqual(
    retryLoginTypingView({ busy: true, id: 'acc-1', stage: 'logging-in' }),
    {
      visible: true,
      label: 'Retry login typing',
      title: 'Close Riot/League and repeat this login attempt.'
    }
  );
});
