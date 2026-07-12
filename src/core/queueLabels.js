const QUEUE_LABELS = {
  0: 'Custom', 72: '1v1 Snowdown', 73: '2v2 Snowdown', 75: 'Hexakill', 76: 'URF',
  78: 'One for All Mirror', 83: 'Co-op URF', 98: 'Hexakill', 100: 'ARAM', 310: 'Nemesis',
  313: 'Black Market', 317: 'Definitely Not Dominion', 325: 'All Random', 400: 'Draft',
  420: 'Ranked Solo', 430: 'Blind', 440: 'Ranked Flex', 450: 'ARAM', 480: 'Swiftplay',
  490: 'Quickplay', 600: 'Blood Hunt', 610: 'Dark Star', 700: 'Clash', 720: 'ARAM Clash',
  820: 'Co-op Beginner', 830: 'Co-op Intro', 840: 'Co-op Beginner', 850: 'Co-op Intermediate',
  870: 'Co-op Intro', 880: 'Co-op Beginner', 890: 'Co-op Intermediate', 900: 'ARURF',
  910: 'Ascension', 920: 'Poro King', 940: 'Nexus Siege', 950: 'Doom Bots', 960: 'Doom Bots',
  980: 'Star Guardian', 990: 'Star Guardian', 1000: 'PROJECT', 1010: 'Snow ARURF',
  1020: 'One for All', 1030: 'Odyssey', 1040: 'Odyssey', 1050: 'Odyssey', 1060: 'Odyssey',
  1070: 'Odyssey', 1090: 'TFT Normal', 1100: 'TFT Ranked', 1110: 'TFT Tutorial',
  1111: 'TFT Test', 1130: 'TFT Hyper Roll', 1160: 'TFT Double Up', 1210: 'TFT Choncc',
  1300: 'Nexus Blitz', 1400: 'Ultimate Spellbook', 1700: 'Arena', 1710: 'Arena',
  1750: 'Arena', 1810: 'Swarm', 1820: 'Swarm', 1830: 'Swarm', 1840: 'Swarm', 1900: 'URF',
  2000: 'Tutorial', 2010: 'Tutorial', 2020: 'Tutorial', 2300: 'Brawl', 2400: 'ARAM Mayhem'
};

const QUEUE_TYPE_LABELS = {
  ARAM_UNRANKED_5x5: 'ARAM',
  CHERRY: 'Arena',
  CLASSIC: 'Summoner\'s Rift',
  CUSTOM: 'Custom',
  KIWI: 'ARAM Mayhem',
  NORMAL: 'Normal',
  NORMAL_DRAFT: 'Draft',
  RANKED_FLEX_SR: 'Ranked Flex',
  RANKED_SOLO_5x5: 'Ranked Solo',
  RANKED_TFT: 'TFT Ranked'
};

function numberFrom(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function titleFromToken(value) {
  return String(value || '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase())
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function queueLabelFrom(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const numeric = numberFrom(text);
  if (numeric !== null && QUEUE_LABELS[numeric]) return QUEUE_LABELS[numeric];
  return QUEUE_TYPE_LABELS[text] || titleFromToken(text);
}

export function knownQueueIdLabel(value) {
  const numeric = numberFrom(value);
  return numeric !== null ? (QUEUE_LABELS[numeric] || '') : '';
}

export function gameQueueDescriptor(queue = {}) {
  const numericId = numberFrom(queue.id ?? queue.queueId);
  const type = String(queue.type || queue.queueType || '').trim();
  const name = String(queue.name || '').trim();
  const gameMode = String(queue.gameMode || '').trim();
  const key = numericId !== null
    ? `id:${numericId}`
    : type
      ? `type:${type.toUpperCase()}`
      : gameMode
        ? `mode:${gameMode.toUpperCase()}`
        : 'unknown';
  const label = knownQueueIdLabel(numericId)
    || queueLabelFrom(type)
    || name
    || queueLabelFrom(gameMode)
    || (numericId !== null ? `Queue ${numericId}` : 'Unknown queue');
  return {
    key,
    label,
    queueId: numericId,
    type: type || null,
    gameMode: gameMode || null
  };
}
