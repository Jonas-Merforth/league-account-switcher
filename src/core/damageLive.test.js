import test from 'node:test';
import assert from 'node:assert/strict';
import { DamageLive } from './damageLive.js';

const player = (name, model, riotId = `${name}#1`) => ({ riotId, championName: name, rawChampionName: `game_character_displayname_${model}` });
const sample = (gameTime, players, me = 'Galio#1') => ({ gameData: { gameTime }, activePlayer: { riotId: me }, allPlayers: players });
const roster = [player('Miss Fortune', 'MissFortune'), player('Sion', 'Sion'), player('Galio', 'Galio'), player('Viktor', 'Viktor'), player('Kayle', 'Kayle')];

test('names champions from the roster order when the opening spawns were missed', () => {
  const live = new DamageLive('unused.pcapng');
  // At game time 0 League lists the local player first. That order is ignored.
  live.sample(sample(0, [roster[2], roster[0], roster[1], roster[3], roster[4]]), 0, 0);
  live.owner = 0x40000041;
  live.inferHeroes();
  assert.equal(live.heroes.size, 0);

  live.sample(sample(200, roster), 0, 0);
  assert.deepEqual([...live.heroes], [[0x4000003f, 'missfortune'], [0x40000040, 'sion'], [0x40000041, 'galio'],
    [0x40000042, 'viktor'], [0x40000043, 'kayle']]);
  assert.equal(live.heroesInferred, true);
  assert.equal(live.heroesKnown, true);
  const named = live.nameParties([
    { id: String(0x40000042), kind: 'champion', amount: 50, hits: 1, types: { magic: 50 } },
    { id: '1073742200', kind: 'unclassified', amount: 30, hits: 2, types: { magic: 30 } },
    { id: '1073742201', kind: 'unclassified', amount: 20, hits: 1, types: { magic: 20 } }
  ], 'Unidentified targets');
  assert.deepEqual(named.map(({ name, amount, hits }) => [name, amount, hits]),
    [['Viktor', 50, 1], ['Minions, turrets & monsters', 50, 3]]);

  // Viego's possession repeats a name. Such samples leave the mapping alone.
  live.sample(sample(300, [roster[0], roster[1], roster[2], roster[3], player('Kayle', 'Viktor', 'Viego#1')]), 0, 0);
  assert.equal(live.heroes.get(0x40000043), 'kayle');
});

test('spawn messages win over the roster and disagreeing rosters are not used', () => {
  const live = new DamageLive('unused.pcapng');
  live.owner = 0x40000041;
  live.heroModels.set(0x40000041, 'galio');
  live.heroModels.set(0x40000042, 'viktor');
  live.sample(sample(5, roster), 0, 0);
  assert.equal(live.heroes.get(0x4000003f), 'missfortune');
  assert.equal(live.heroes.get(0x40000041), 'galio');

  // A roster that would put another champion on a spawned ID is discarded.
  live.heroModels.set(0x40000043, 'zed');
  live.refreshHeroes();
  assert.equal(live.heroes, live.heroModels);
  assert.equal(live.heroesInferred, false);
});
