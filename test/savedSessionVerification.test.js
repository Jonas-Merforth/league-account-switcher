import test from 'node:test';
import assert from 'node:assert/strict';
import { savedSessionVerification, sessionAgeWarning } from '../src/core/savedSessionVerification.js';
import { accountSessionView } from '../src/renderer/accountDisplay.js';

const now = 1_800_000_000_000;
const stale = { hasSession: true, sessionAge: { stale: true, text: 'Session saved 30d ago' } };
const cached = { version: 'rotated-snapshot', verifiedAt: now - 1000, expiresAt: now + 120_000,
  auth: { accessToken: 'secret', refreshToken: 'secret' } };

test('a recent saved-session authentication suppresses the warning in cards and tray without exposing tokens', () => {
  const verification = savedSessionVerification(cached, 'rotated-snapshot', now);
  assert.deepEqual(verification, { source: 'friends', verifiedAt: now - 1000, validUntil: now + 60_000 });
  assert.equal(JSON.stringify(verification).includes('secret'), false);
  const account = { ...stale, sessionVerification: verification };
  assert.equal(sessionAgeWarning(account, now), false);
  assert.equal(accountSessionView(account, now).text, 'Session verified by Friends');
  assert.equal(accountSessionView(account, now).className, 'tag');
});

test('verification expires even if Friends stops refreshing, restoring the age warning', () => {
  const account = { ...stale, sessionVerification: savedSessionVerification(cached, 'rotated-snapshot', now) };
  assert.equal(sessionAgeWarning(account, now + 60_000), true);
  assert.equal(accountSessionView(account, now + 60_000).className, 'tag warn');
  assert.match(accountSessionView(account, now + 60_000).text, /may be expired/);
  assert.equal(savedSessionVerification(cached, 'rotated-snapshot', now + 60_000), null);
});

test('replaced, deleted and never-validated snapshots cannot borrow verification from old auth', () => {
  for (const [entry, version] of [[cached, 'recaptured-snapshot'], [cached, null], [undefined, 'rotated-snapshot']]) {
    const verification = savedSessionVerification(entry, version, now);
    assert.equal(verification, null);
    assert.equal(sessionAgeWarning({ ...stale, sessionVerification: verification }, now), true);
  }
});

test('a live-client Friends result or merely selected source is not saved-session proof', () => {
  for (const account of [stale, { ...stale, selected: true }, { ...stale, sessionVerification: { source: 'live-client', validUntil: now + 60_000 } }]) {
    assert.equal(sessionAgeWarning(account, now), true);
    assert.equal(accountSessionView(account, now).className, 'tag warn');
  }
});

test('missing and young sessions keep their existing accurate labels', () => {
  const verification = savedSessionVerification(cached, 'rotated-snapshot', now);
  assert.equal(accountSessionView({ hasSession: false, hasPassword: true, sessionVerification: verification }, now).text,
    'No saved session — will sign in with password');
  assert.equal(accountSessionView({ hasSession: false }, now).text, 'No saved session — capture or add a password');
  assert.deepEqual(accountSessionView({ hasSession: true, sessionAge: { text: 'Session saved today', stale: false } }, now),
    { className: 'tag', text: 'Session saved today' });
});
