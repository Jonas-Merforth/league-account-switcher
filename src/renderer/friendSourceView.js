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

// Flattens an accounts-tab layout into the order its accounts appear on screen:
// unordered (top) accounts first, then each section's accounts, all top-to-bottom.
export function friendSourceOrder(layout = {}) {
  const order = [];
  for (const id of layout?.top || []) order.push(id);
  for (const section of layout?.sections || []) {
    for (const id of section?.accountIds || []) order.push(id);
  }
  return order;
}

export function sortFriendSourceAccounts(accounts = [], orderIds = []) {
  const rank = new Map();
  orderIds.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  const rankOf = (account) => {
    const r = rank.get(account?.accountId ?? account?.id);
    return Number.isInteger(r) ? r : Number.POSITIVE_INFINITY;
  };
  return [...accounts].sort((a, b) => {
    // Primary: match the accounts-tab order (top accounts first, then sections).
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    // Fallback for accounts missing from the layout: most online first, then size, then label.
    const onlineDelta = accountOnlineCount(b) - accountOnlineCount(a);
    if (onlineDelta !== 0) return onlineDelta;
    const totalDelta = accountFriendCount(b) - accountFriendCount(a);
    if (totalDelta !== 0) return totalDelta;
    return text(a?.label).localeCompare(text(b?.label));
  });
}

export function friendSourceSummary(accounts = [], errors = [], { expanded = false, previewCount = 2, order = [] } = {}) {
  const accountItems = sortFriendSourceAccounts(accounts, order).map((account) => ({ kind: 'account', account }));
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

function normalizedFriendSource(source) {
  if (source && typeof source === 'object') {
    return {
      accountId: text(source.accountId ?? source.id),
      label: text(source.label) || 'Account'
    };
  }
  return { accountId: '', label: text(source) };
}

function loginCountFor(source, loginCounts) {
  const value = loginCounts instanceof Map
    ? loginCounts.get(source.accountId)
    : loginCounts?.[source.accountId];
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

export function sortFriendCardSources(sources = [], { loginCounts = {}, order = [] } = {}) {
  const orderRank = new Map((order || []).map((id, index) => [String(id), index]));
  return (Array.isArray(sources) ? sources : [])
    .map(normalizedFriendSource)
    .filter((source) => source.label)
    .sort((a, b) => {
      const countDelta = loginCountFor(b, loginCounts) - loginCountFor(a, loginCounts);
      if (countDelta !== 0) return countDelta;
      const aRank = orderRank.get(a.accountId);
      const bRank = orderRank.get(b.accountId);
      if (Number.isInteger(aRank) || Number.isInteger(bRank)) {
        if (!Number.isInteger(aRank)) return 1;
        if (!Number.isInteger(bRank)) return -1;
        if (aRank !== bRank) return aRank - bRank;
      }
      return a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId);
    });
}

// Friend cards always expose one preferred source and collapse every other account into +N.
export function friendCardSourceSummary(sources = [], {
  loginCounts = {},
  order = []
} = {}) {
  const sorted = sortFriendCardSources(sources, { loginCounts, order });
  return {
    shown: sorted.slice(0, 1),
    hidden: sorted.slice(1),
    all: sorted
  };
}

export function playingWithBadgeLabel(count, { compact = false } = {}) {
  const total = Math.max(0, Number(count) || 0);
  if (compact) return `+${total}`;
  return total === 1 ? 'With 1 friend' : `With ${total} friends`;
}
