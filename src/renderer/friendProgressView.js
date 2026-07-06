function text(value) {
  return String(value ?? '').trim();
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function rowStatus(phase) {
  if (phase === 'account-done') return 'done';
  if (phase === 'account-error') return 'error';
  if (phase === 'account-delay') return 'waiting';
  return 'active';
}

export function progressHeadline(progress = {}) {
  const phase = text(progress.phase);
  if (phase === 'refresh-start') return progress.message || 'Starting friend refresh...';
  if (phase === 'refresh-done') return progress.message || 'Finished friend refresh.';
  return 'Refreshing saved-session friend lists...';
}

export function progressMeter(progress = {}, fallbackTotal = 0) {
  const total = number(progress.accountTotal) || number(fallbackTotal);
  const done = Math.min(total, Math.max(0, number(progress.accountDone)));
  return {
    total,
    done,
    percent: total ? Math.round((done / total) * 100) : 0
  };
}

export function updateProgressRows(rows = [], progress = {}) {
  const phase = text(progress.phase);
  if (phase === 'refresh-start') return [];

  const accountIndex = number(progress.accountIndex);
  const label = text(progress.accountLabel);
  if (!accountIndex || !label) return rows;

  const key = text(progress.accountId) || `index:${accountIndex}`;
  const next = new Map(rows.map((row) => [row.key, row]));
  next.set(key, {
    key,
    index: accountIndex,
    label,
    status: rowStatus(phase),
    message: progress.message || label,
    error: text(progress.error)
  });
  return [...next.values()].sort((a, b) => a.index - b.index);
}
