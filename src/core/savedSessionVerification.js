export const SAVED_SESSION_AGE_WARNING_MS = 14 * 86_400_000;

// Project only non-secret evidence from authentication of the saved snapshot.
export function savedSessionVerification(cached, snapshotVersion, now = Date.now(), safetyMs = 60_000) {
  const validUntil = Number(cached?.expiresAt) - safetyMs;
  if (!snapshotVersion || cached?.version !== snapshotVersion || !Number.isFinite(validUntil) || validUntil <= now) return null;
  return { source: 'friends', verifiedAt: cached.verifiedAt, validUntil };
}

export function renewedSessionVerification(renewal, snapshotVersion, now = Date.now()) {
  const { version, verifiedAt } = renewal ?? {};
  if (!snapshotVersion || version !== snapshotVersion || !Number.isFinite(verifiedAt) || verifiedAt > now) return null;
  const validUntil = verifiedAt + SAVED_SESSION_AGE_WARNING_MS;
  return validUntil > now ? { source: 'friends', verifiedAt, validUntil, renewed: true } : null;
}

export function isSavedSessionVerified(verification, now = Date.now()) {
  return verification?.source === 'friends' && Number.isFinite(verification.validUntil) && verification.validUntil > now;
}

export function sessionAgeWarning(account, now = Date.now()) {
  return Boolean(account.hasSession && !account.isCurrent && account.sessionAge?.stale
    && !isSavedSessionVerified(account.sessionVerification, now));
}
