// Pure lane normalization and matchup pairing shared by the live Gold tracker
// and the browser renderer (no Node built-ins).

export const LANE_ORDER = Object.freeze(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']);
export const LANE_LABELS = Object.freeze({ TOP: 'Top', JUNGLE: 'Jgl', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Sup' });

const POSITION_ALIASES = Object.freeze({
  TOP: 'TOP',
  JUNGLE: 'JUNGLE',
  MIDDLE: 'MIDDLE',
  MID: 'MIDDLE',
  BOTTOM: 'BOTTOM',
  BOT: 'BOTTOM',
  CARRY: 'BOTTOM',
  ADC: 'BOTTOM',
  UTILITY: 'UTILITY',
  SUPPORT: 'UTILITY',
  SUP: 'UTILITY'
});

export function normalizePosition(position, timeline) {
  const direct = typeof position === 'string' ? POSITION_ALIASES[position.trim().toUpperCase()] : null;
  if (direct) return direct;
  if (!timeline) return null;
  const lane = typeof timeline.lane === 'string' ? timeline.lane.trim().toUpperCase() : '';
  const role = typeof timeline.role === 'string' ? timeline.role.trim().toUpperCase() : '';
  if (lane === 'BOTTOM' || lane === 'BOT') {
    if (role === 'DUO_SUPPORT' || role === 'SUPPORT') return 'UTILITY';
    if (role === 'DUO_CARRY' || role === 'CARRY' || role === 'SOLO') return 'BOTTOM';
  }
  return POSITION_ALIASES[lane] || null;
}

// Pairs allied and enemy champions by lane (Top vs Top, Jgl vs Jgl, Mid vs Mid,
// Bot vs Bot, Sup vs Sup). Modes without lane roles pair players by gold rank.
export function pairGoldMatchups(teams) {
  const allyGroup = (teams || []).find((group) => group.side === 'ally') || teams?.[0] || null;
  const enemyGroup = (teams || []).find((group) => group.side === 'enemy') || (teams?.length > 1 ? teams[1] : null);
  const allies = [...(allyGroup?.players || [])];
  const enemies = [...(enemyGroup?.players || [])];
  if (!allies.length && !enemies.length) return { hasLanes: false, rows: [] };

  const allyHasLane = allies.some((player) => LANE_ORDER.includes(player.position));
  const enemyHasLane = enemies.some((player) => LANE_ORDER.includes(player.position));
  const hasLanes = allyHasLane && (enemyHasLane || !enemies.length);

  const rows = [];
  if (hasLanes) {
    const usedAlly = new Set();
    const usedEnemy = new Set();
    for (const lane of LANE_ORDER) {
      const ally = allies.find((player) => !usedAlly.has(player) && player.position === lane) || null;
      const enemy = enemies.find((player) => !usedEnemy.has(player) && player.position === lane) || null;
      if (!ally && !enemy) continue;
      if (ally) usedAlly.add(ally);
      if (enemy) usedEnemy.add(enemy);
      rows.push({
        lane,
        laneLabel: LANE_LABELS[lane],
        ally,
        enemy,
        diff: ally && enemy ? ally.gold - enemy.gold : null,
        isYou: !!(ally?.you || enemy?.you)
      });
    }
    const restAllies = allies.filter((player) => !usedAlly.has(player)).sort((a, b) => b.gold - a.gold);
    const restEnemies = enemies.filter((player) => !usedEnemy.has(player)).sort((a, b) => b.gold - a.gold);
    const extra = Math.max(restAllies.length, restEnemies.length);
    for (let i = 0; i < extra; i++) {
      const ally = restAllies[i] || null;
      const enemy = restEnemies[i] || null;
      rows.push({
        lane: null,
        laneLabel: '',
        ally,
        enemy,
        diff: ally && enemy ? ally.gold - enemy.gold : null,
        isYou: !!(ally?.you || enemy?.you)
      });
    }
    return { hasLanes: true, rows };
  }

  allies.sort((a, b) => b.gold - a.gold);
  enemies.sort((a, b) => b.gold - a.gold);
  const count = Math.max(allies.length, enemies.length);
  for (let i = 0; i < count; i++) {
    const ally = allies[i] || null;
    const enemy = enemies[i] || null;
    rows.push({
      lane: null,
      laneLabel: enemies.length ? `#${i + 1}` : '',
      ally,
      enemy,
      diff: ally && enemy ? ally.gold - enemy.gold : null,
      isYou: !!(ally?.you || enemy?.you)
    });
  }
  return { hasLanes: false, rows };
}
