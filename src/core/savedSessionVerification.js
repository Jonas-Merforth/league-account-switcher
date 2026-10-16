// Project only non-secret evidence from the main-process authentication cache. A live-client
// Friends roster is deliberately insufficient: it need not have used the saved snapshot at all.
export function savedSessionVerification(cached, snapshotVersion, now = Date.now(), safetyMs = 60_000) {
  const validUntil = Number(cached?.expiresAt) - safetyMs;
  if (!snapshotVersion || cached?.version !== snapshotVersion || !Number.isFinite(validUntil) || validUntil <= now) return null;
  return { source: 'friends', verifiedAt: cached.verifiedAt, validUntil };
}

export function isSavedSessionVerified(verification, now = Date.now()) {
  return verification?.source === 'friends' && Number.isFinite(verification.validUntil) && verification.validUntil > now;
}

export function sessionAgeWarning(account, now = Date.now()) {
  return Boolean(account.hasSession && account.sessionAge?.stale && !isSavedSessionVerified(account.sessionVerification, now));
}
