// Pure, fs-free layout model shared by the renderer, main, and tests. The layout groups account ids
// into a top "Unordered" group plus named, collapsible sections. It lives in its own switcher-only
// file (switcher-layout.json) keyed by account id — never on the account objects, because accounts.json
// is shared with league-client-automation and both apps strip unknown fields via normalizeAccount.

export function defaultLayout() {
  return { top: [], sections: [] };
}

function cleanIdList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const id = typeof entry === 'string' ? entry.trim() : '';
    if (id) out.push(id);
  }
  return out;
}

let fallbackCounter = 0;
function fallbackSectionId() {
  fallbackCounter += 1;
  return `sec-${fallbackCounter}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function normalizeLayout(input = {}) {
  const top = cleanIdList(input?.top);
  const sections = (Array.isArray(input?.sections) ? input.sections : []).map((section) => ({
    id: typeof section?.id === 'string' && section.id.trim() ? section.id.trim() : fallbackSectionId(),
    name: String(section?.name ?? '').trim() || 'Section',
    collapsed: Boolean(section?.collapsed),
    accountIds: cleanIdList(section?.accountIds)
  }));
  // Ensure section ids are unique.
  const seen = new Set();
  for (const section of sections) {
    while (seen.has(section.id)) section.id = fallbackSectionId();
    seen.add(section.id);
  }
  return { top, sections };
}

// Reconcile a (possibly stale) layout against the current set of account ids:
//  - every id appears exactly once (first occurrence wins),
//  - ids not in `accountIds` are pruned (deleted accounts),
//  - accounts not referenced anywhere are appended to `top` (new accounts land in Unordered).
// Section name/collapsed/order are preserved.
export function reconcileLayout(layout, accountIds) {
  const valid = new Set(accountIds);
  const used = new Set();
  const take = (ids) => {
    const out = [];
    for (const id of ids) {
      if (valid.has(id) && !used.has(id)) {
        used.add(id);
        out.push(id);
      }
    }
    return out;
  };

  const norm = normalizeLayout(layout);
  const top = take(norm.top);
  const sections = norm.sections.map((section) => ({
    id: section.id,
    name: section.name,
    collapsed: section.collapsed,
    accountIds: take(section.accountIds)
  }));

  // New accounts (not referenced anywhere yet) → append to the Unordered top group, in order.
  for (const id of accountIds) {
    if (!used.has(id)) {
      used.add(id);
      top.push(id);
    }
  }

  return { top, sections };
}
