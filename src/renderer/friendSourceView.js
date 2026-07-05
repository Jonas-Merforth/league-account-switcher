function text(value) {
  return String(value ?? '').trim();
}

function accountOnlineCount(account) {
  const count = Number(account?.onlineCount);
  return Number.isFinite(count) ? count : 0;
}

function accountFriendCount(account) {
  const count = Array.isArray(account?.friends) ? account.friends.length : Number(account?.friendCount);
  return Number.isFinite(count) ? count : 0;
}

export function sortFriendSourceAccounts(accounts = []) {
  return [...accounts].sort((a, b) => {
    const onlineDelta = accountOnlineCount(b) - accountOnlineCount(a);
    if (onlineDelta !== 0) return onlineDelta;
    const totalDelta = accountFriendCount(b) - accountFriendCount(a);
    if (totalDelta !== 0) return totalDelta;
    return text(a?.label).localeCompare(text(b?.label));
  });
}

export function friendSourceSummary(accounts = [], errors = [], { expanded = false, previewCount = 2 } = {}) {
  const accountItems = sortFriendSourceAccounts(accounts).map((account) => ({ kind: 'account', account }));
  const errorItems = [...(Array.isArray(errors) ? errors : [])]
    .sort((a, b) => text(a?.label).localeCompare(text(b?.label)))
    .map((error) => ({ kind: 'error', error }));
  const items = [...accountItems, ...errorItems];
  const count = Math.max(0, Number(previewCount) || 0);
  return {
    items: expanded ? items : items.slice(0, count),
    hiddenCount: expanded ? 0 : Math.max(0, items.length - count),
    totalCount: items.length
  };
}
