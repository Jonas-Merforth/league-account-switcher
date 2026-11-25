import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renewedSessionVerification, savedSessionVerification, SAVED_SESSION_AGE_WARNING_MS, sessionAgeWarning
} from '../src/core/savedSessionVerification.js';
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

test('verification without a recorded renewal expires with Friends access tokens', () => {
  const account = { ...stale, sessionVerification: savedSessionVerification(cached, 'rotated-snapshot', now) };
  assert.equal(sessionAgeWarning(account, now + 60_000), true);
  assert.equal(accountSessionView(account, now + 60_000).className, 'tag warn');
  assert.match(accountSessionView(account, now + 60_000).text, /may be expired/);
  assert.equal(savedSessionVerification(cached, 'rotated-snapshot', now + 60_000), null);
});

test('a recorded renewal starts a new age-warning window for the exact saved snapshot', () => {
  const renewal = { version: 'rotated-snapshot', verifiedAt: now };
  const validUntil = now + SAVED_SESSION_AGE_WARNING_MS;
  const verification = renewedSessionVerification(renewal, renewal.version, validUntil - 1);
  assert.deepEqual(verification, { source: 'friends', verifiedAt: now, validUntil, renewed: true });
  const account = { ...stale, sessionVerification: verification };
  assert.equal(accountSessionView(account, validUntil - 1).text, 'Session verified by Friends');
  assert.equal(sessionAgeWarning(account, validUntil - 1), false);
  assert.equal(sessionAgeWarning(account, validUntil), true);
  assert.equal(renewedSessionVerification(renewal, renewal.version, validUntil), null);
  assert.equal(renewedSessionVerification(renewal, 'recaptured-snapshot', now), null);
  assert.equal(renewedSessionVerification(renewal, renewal.version, now - 1), null);
});

test('the active account shows its live sign-in even when its saved session is old', () => {
  const signedIn = { ...stale, isCurrent: true };
  assert.deepEqual(accountSessionView(signedIn, now), {
    className: 'tag', text: 'Signed in to Riot Client', title: 'Session saved 30d ago'
  });
  assert.equal(sessionAgeWarning(signedIn, now), false);
  assert.equal(accountSessionView({ ...signedIn, isCurrent: false }, now).className, 'tag warn');
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
