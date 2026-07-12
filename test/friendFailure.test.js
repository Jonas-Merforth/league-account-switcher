import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFriendFailure, friendFailureDetails, reauthenticationFailures } from '../src/core/friendFailure.js';

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

test('classifies session authentication failures for reauthentication', () => {
  for (const code of ['FRIENDS_SESSION_MISSING_SSID', 'FRIENDS_SESSION_INTERACTIVE_AUTH', 'FRIENDS_SESSION_AUTH_REJECTED', 'FRIENDS_TOKEN_AUTH_REJECTED', 'FRIENDS_XMPP_AUTH_FAILED']) {
    assert.deepEqual(classifyFriendFailure(coded(code)), {
      code, category: 'session-auth', retryable: false, recommendedAction: 'reauthenticate'
    });
  }
});

test('classifies transient, local, and unknown failures', () => {
  assert.equal(classifyFriendFailure(Object.assign(new Error('busy'), { status: 429 })).code, 'FRIENDS_RATE_LIMITED');
  assert.equal(classifyFriendFailure(Object.assign(new Error('down'), { status: 503 })).code, 'FRIENDS_SERVICE_UNAVAILABLE');
  assert.deepEqual(classifyFriendFailure(coded('ETIMEDOUT')), {
    code: 'FRIENDS_NETWORK_ERROR', category: 'transient', retryable: true, recommendedAction: 'retry'
  });
  assert.deepEqual(classifyFriendFailure(coded('ENOENT')), {
    code: 'FRIENDS_LOCAL_SESSION_ERROR', category: 'local', retryable: false, recommendedAction: 'inspect'
  });
  assert.deepEqual(classifyFriendFailure(new Error('surprising response')), {
    code: 'FRIENDS_UNKNOWN_ERROR', category: 'unknown', retryable: true, recommendedAction: 'retry'
  });
});

test('preserves existing error fields and filters only repairable failures', () => {
  const account = { id: 'a1', label: 'One' };
  const repair = friendFailureDetails(account, coded('FRIENDS_SESSION_AUTH_REJECTED', 'expired'));
  const retry = friendFailureDetails(account, coded('ECONNRESET', 'reset'));
  assert.deepEqual({ accountId: repair.accountId, label: repair.label, error: repair.error }, {
    accountId: 'a1', label: 'One', error: 'expired'
  });
  assert.deepEqual(reauthenticationFailures([repair, retry]), [repair]);
});
