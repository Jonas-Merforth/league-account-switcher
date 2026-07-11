// Pure view models for the rank crests on the account cards (unit-tested, no DOM).
// account.ranks -> two entries, Solo/Duo first, Flex second.

const QUEUES = [
  { key: 'solo', label: 'Solo/Duo' },
  { key: 'flex', label: 'Flex 5v5' }
];
const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };
const TIER_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const ACTIVE_RANK_ACTIVITY_KINDS = new Set(['lobby', 'queue', 'champSelect', 'inGame']);

const cap = (tier) => tier.charAt(0) + tier.slice(1).toLowerCase();
const recordLine = (entry) => entry.losses == null
  ? `${entry.wins} Wins | Losses unavailable`
  : `${entry.wins} Wins | ${entry.losses} Losses`;

// Each view: { queue, label, img, overlay, state: 'ranked'|'unranked'|'unknown', tip: [line, ...] }
export function rankViews(ranks) {
  return QUEUES.map(({ key, label }) => {
    if (!ranks) {
      return {
        queue: key, label, img: 'ranks/unranked.png', overlay: '?', state: 'unknown',
        tip: [label.toUpperCase(), 'Rank not fetched yet', 'Switch to this account to update']
      };
    }
    const entry = ranks[key];
    if (!entry) {
      return {
        queue: key, label, img: 'ranks/unranked.png', overlay: '', state: 'unranked',
        tip: [label.toUpperCase(), 'Unranked']
      };
    }
    const division = entry.division ? ` ${ROMAN[entry.division] ?? entry.division}` : '';
    return {
      queue: key,
      label,
      img: `ranks/${entry.tier.toLowerCase()}.png`,
      overlay: entry.division ? String(entry.division) : '',
      state: 'ranked',
      tip: [
        label.toUpperCase(),
        `${cap(entry.tier)}${division} — ${entry.lp} LP`,
        recordLine(entry)
      ]
    };
  });
}

export function activeFriendRankQueue(activity = {}) {
  // Queue details can linger in Riot presence after a match. Only treat the queue as active while
  // the normalized presence is in a phase where the friend is actually playing or preparing to.
  if (!ACTIVE_RANK_ACTIVITY_KINDS.has(String(activity.kind || ''))) return null;
  const queueId = Number(activity.queueId);
  if (queueId === 420) return 'solo';
  if (queueId === 440) return 'flex';
  const text = `${activity.gameQueueType || ''} ${activity.queueLabel || ''}`.toUpperCase();
  if (/RANKED[_ ]SOLO/.test(text)) return 'solo';
  if (/RANKED[_ ]FLEX/.test(text)) return 'flex';
  return null;
}

function rankScore(entry) {
  if (!entry) return -1;
  const tier = TIER_ORDER.indexOf(String(entry.tier || '').toUpperCase());
  const division = entry.division == null ? 5 : 5 - Number(entry.division || 5);
  return tier * 1_000_000 + division * 10_000 + (Number(entry.lp) || 0);
}

// One compact crest for a friend row. In a ranked activity it follows that queue; otherwise it
// chooses the higher current SR rank. The tooltip always retains both Solo/Duo and Flex details.
export function smartFriendRankView(friend = {}) {
  if (!friend.online || !friend.ranks) return null;
  const views = rankViews(friend.ranks);
  const activeQueue = activeFriendRankQueue(friend.activity);
  let selected = activeQueue ? views.find((view) => view.queue === activeQueue) : null;
  if (!selected) {
    selected = rankScore(friend.ranks.flex) > rankScore(friend.ranks.solo) ? views[1] : views[0];
  }
  const activeLabel = activeQueue === 'solo' ? 'Ranked Solo' : activeQueue === 'flex' ? 'Ranked Flex' : '';
  const queueLine = (view) => `${view.label}: ${view.tip.slice(1).join(' · ')}`;
  return {
    ...selected,
    active: Boolean(activeQueue),
    activeQueue,
    tip: [
      activeLabel ? `PLAYING ${activeLabel.toUpperCase()}` : 'CURRENT RANKS',
      ...views.map(queueLine)
    ]
  };
}
