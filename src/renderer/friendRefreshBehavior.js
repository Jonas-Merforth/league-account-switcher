export const FRIENDS_CLICK_REFRESH_COOLDOWN_MS = 10_000;

export function shouldRefreshFriendsOnTabClick({
  selectedSourceCount = 0,
  loading = false,
  lastAutoRefreshAt = 0,
  now = Date.now(),
  cooldownMs = FRIENDS_CLICK_REFRESH_COOLDOWN_MS
} = {}) {
  if (loading) return false;
  if (Number(selectedSourceCount) <= 0) return false;

  const lastAuto = Number(lastAutoRefreshAt);
  if (!Number.isFinite(lastAuto) || lastAuto <= 0) return true;

  const elapsed = Math.max(0, Number(now) - lastAuto);
  return elapsed >= cooldownMs;
}
