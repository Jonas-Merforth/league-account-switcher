// Pure view models for the rank crests on the account cards (unit-tested, no DOM).
// account.ranks -> two entries, Solo/Duo first, Flex second.

const QUEUES = [
  { key: 'solo', label: 'Solo/Duo' },
  { key: 'flex', label: 'Flex 5v5' }
];
const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V' };

const cap = (tier) => tier.charAt(0) + tier.slice(1).toLowerCase();

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
        `${entry.wins} Wins | ${entry.losses} Losses`
      ]
    };
  });
}
