import test from 'node:test';
import assert from 'node:assert/strict';
import { HealingTracker, antiHealAdvice, antiHealItemIds, healedBack, isAntiHealItem } from './healingTracker.js';
import { DamageLive } from './damageLive.js';

test('credits heals to the healer and splits self from ally healing', () => {
  const tracker = new HealingTracker();
  tracker.heal({ sourceId: 1, targetId: 1, amount: 120 });
  tracker.heal({ sourceId: 1, targetId: 2, amount: 80 });
  tracker.heal({ sourceId: 1, targetId: 2, amount: 0 });
  tracker.heal({ sourceId: 1, targetId: 2, amount: Number.NaN });
  tracker.heal({ sourceId: 0, targetId: 2, amount: 50 });
  assert.deepEqual(tracker.totals(1), { total: 200, self: 120, allies: 80, received: 120, taken: 0 });
  assert.deepEqual(tracker.totals(2), { total: 0, self: 0, allies: 0, received: 80, taken: 0 });
  assert.equal(tracker.events, 2);
});

test('counts health lost, adding back the healing received since the last update', () => {
  const tracker = new HealingTracker();
  tracker.heal({ sourceId: 2, targetId: 1, amount: 40 });
  // The first record only sets the starting health.
  tracker.health({ id: 1, health: 1000 });
  tracker.health({ id: 1, health: 900 });
  // A heal of 50 in the same update as a 150 hit shows as a drop of 100.
  tracker.heal({ sourceId: 2, targetId: 1, amount: 50 });
  tracker.health({ id: 1, health: 800 });
  // Regeneration, a heal on its own and a respawn are not damage.
  tracker.health({ id: 1, health: 810 });
  tracker.heal({ sourceId: 1, targetId: 1, amount: 30 });
  tracker.health({ id: 1, health: 840 });
  tracker.health({ id: 1, health: 0 });
  tracker.health({ id: 1, health: 1200 });
  assert.equal(tracker.totals(1).taken, 100 + 150 + 840);
  assert.equal(tracker.totals(1).received, 120);
});

test('reads Wounds items from League item data and falls back to the known items', () => {
  const ids = antiHealItemIds([
    { id: 3075, description: '<passive>Thorns</passive> apply 40% <keyword>Wounds</keyword> for 3 seconds' },
    { id: 3123, description: '<passive>Grievous Wounds</passive> Dealing physical damage applies 40% Wounds' },
    { id: 3070, description: 'Grants mana. Woundsless' },
    { id: 1055, description: 'Restores health on hit.' }
  ]);
  assert.deepEqual(ids, [3075, 3123]);
  assert.equal(antiHealItemIds([{ id: 1055, description: 'Restores health.' }]), null);
  assert.equal(isAntiHealItem(3075, new Set(ids)), true);
  assert.equal(isAntiHealItem(3165, new Set(ids)), false);
  // Without item data, the built-in list also covers the mode variants.
  assert.equal(isAntiHealItem(3165), true);
  assert.equal(isAntiHealItem(223165), true);
  assert.equal(isAntiHealItem(1055), false);
  assert.equal(isAntiHealItem(undefined), false);
});

test('recommends anti-heal only for enemies who heal back a large share and when the team has none', () => {
  const players = [
    { name: 'Soraka', side: 'enemy', total: 9000, taken: 15000 },
    { name: 'Aatrox', side: 'enemy', total: 6000, taken: 20000 },
    { name: 'Lux', side: 'enemy', total: 1500, taken: 2000 },
    { name: 'Teemo', side: 'enemy', total: 2500, taken: 900 },
    { name: 'Vladimir', side: 'ally', total: 30000, taken: 31000 }
  ];
  const advice = antiHealAdvice(players);
  assert.deepEqual(advice.healers.map(({ name }) => name), ['Soraka', 'Aatrox']);
  assert.equal(advice.healers[0].share, 0.6);
  assert.equal(advice.recommended, true);
  assert.equal(healedBack(players[3]), null);

  const covered = antiHealAdvice(players, [
    { name: 'Malphite', item: 'Thornmail', side: 'ally', you: false },
    { name: 'Draven', item: 'Executioner’s Calling', side: 'enemy', you: false }
  ]);
  assert.deepEqual(covered.owners, [{ name: 'Malphite', item: 'Thornmail', you: false }]);
  assert.equal(covered.recommended, false);
  assert.equal(antiHealAdvice(players.slice(2)).healers.length, 0);
});

test('the live meter reports every champion’s healing by side with anti-heal holders from their items', () => {
  const live = new DamageLive('unused.pcapng');
  const players = [
    { riotId: 'Me#1', championName: 'Tahm Kench', rawChampionName: 'game_character_displayname_TahmKench', team: 'ORDER',
      items: [{ itemID: 1054, displayName: 'Doran’s Shield' }] },
    { riotId: 'Ally#1', championName: 'Malphite', rawChampionName: 'game_character_displayname_Malphite', team: 'ORDER',
      items: [{ itemID: 3076, displayName: 'Bramble Vest' }] },
    { riotId: 'Foe#1', championName: 'Soraka', rawChampionName: 'game_character_displayname_Soraka', team: 'CHAOS', items: [] }
  ];
  const data = { gameData: { gameTime: 300 }, activePlayer: { riotId: 'Me#1' }, allPlayers: players };
  const base = 0x40000040;
  live.heroModels.set(base, 'tahmkench');
  live.sample(data, 0, 0);
  assert.equal(live.owner, base);
  assert.equal(live.healingSnapshot(), null);
  live.healing.heal({ sourceId: base + 2, targetId: base + 2, amount: 2500 });
  live.healing.heal({ sourceId: base + 2, targetId: base + 2, amount: 0.5 });
  live.healing.heal({ sourceId: base, targetId: base, amount: 300 });
  for (const [health, id] of [[2000, base + 2], [0, base + 2]]) live.healing.health({ id, health });
  live.wire = { stats: { missing: 0, fragmentLoss: 0 } };
  const healing = live.healingSnapshot();
  assert.deepEqual(healing.players.map(({ name, side, you, total }) => [name, side, you, total]),
    [['Tahm Kench', 'ally', true, 300], ['Malphite', 'ally', false, 0], ['Soraka', 'enemy', false, 2500.5]]);
  assert.equal(healing.duration, 300);
  assert.equal(healing.partial, false);
  assert.deepEqual(healing.antiHeal, { healers: [{ name: 'Soraka', total: 2500.5, share: 2500.5 / 2000 }],
    owners: [{ name: 'Malphite', item: 'Bramble Vest', you: false }], recommended: false });
  assert.deepEqual(live.snapshot().healing, healing);

  // League's item data replaces the built-in list.
  live.setAntiHealItems([3075]);
  live.sample(data, 0, 0);
  assert.equal(live.healingSnapshot().antiHeal.recommended, true);
});
