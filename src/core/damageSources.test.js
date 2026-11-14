import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DamageSourceNames, elfHash, fnvHash, labelSources, readWadScriptNames, SCRIPT_NAME_FIELD } from './damageSources.js';

const key = (...names) => names.map((name) => (typeof name === 'number' ? name : name ? elfHash(name) : 0).toString(16)).join(':');
const live = {
  activePlayer: {
    riotId: 'Me#EUW',
    abilities: {
      Passive: { displayName: 'Garden of Thorns', id: 'ZyraP', rawDisplayName: 'GeneratedTip_Passive_ZyraP_DisplayName' },
      Q: { displayName: 'Deadly Spines', id: 'ZyraQ' },
      E: { displayName: 'Grasping Roots', rawDisplayName: 'GeneratedTip_Spell_ZyraE_DisplayName' },
      R: { displayName: 'Stranglethorns', id: 'ZyraR' }
    },
    fullRunes: { keystone: { displayName: 'Fleet Footwork', rawDisplayName: 'perk_displayname_FleetFootwork' } }
  },
  allPlayers: [{
    riotId: 'Me#EUW', rawChampionName: 'game_character_displayname_Zyra',
    summonerSpells: { summonerSpellOne: { displayName: 'Mark', rawDisplayName: 'GeneratedTip_SummonerSpell_SummonerSnowball_DisplayName' } },
    items: [{ itemID: 6653, displayName: "Liandry's Torment" }]
  }]
};

test('hashes match the names League puts on damage events', () => {
  assert.equal(elfHash('AnnieQ'), 109400001);
  assert.equal(elfHash('AnnieBasicAttack2'), 56275586);
  assert.equal(elfHash('ZyraQPlant'), 0x088f08d4);
  assert.equal(elfHash('zyraqplant'), elfHash('ZyraQPlant'));
  assert.equal(fnvHash('SpellOriginItem'), 0x6a4229fc);
});

test('labels abilities, pets, attacks, items, augments and summoner spells', () => {
  const names = new DamageSourceNames(['6653Burn', 'Augment_ARAM_MagicMissile_Missile1', 'SnowballFollowupCast', 'SummonerSnowball']);
  names.updateLive(live);
  names.addChampionNames(['ZyraQPlant', 'ZyraQPlantMissile', 'ZyraBasicAttack2', 'ZyraRSplash']);
  assert.deepEqual(names.label(key('ZyraQ', 'ZyraQ', 'ZyraQ')), { group: 'ability', slot: 'Q', name: 'Deadly Spines' });
  assert.deepEqual(names.label(key('ZyraQPlant', 'ZyraQPlantMissile', 'ZyraQPlantMissile')),
    { group: 'ability', slot: 'Q', name: 'Deadly Spines', detail: 'Plant' });
  assert.deepEqual(names.label(key('ZyraE', 'ZyraE', 'ZyraE')), { group: 'ability', slot: 'E', name: 'Grasping Roots' });
  assert.deepEqual(names.label(key('ZyraR', 'ZyraR', 'ZyraRSplash')), { group: 'ability', slot: 'R', name: 'Stranglethorns' });
  assert.deepEqual(names.label(key('ZyraBasicAttack2', 0, 'ZyraBasicAttack2')), { group: 'attack', slot: 'AA', name: 'Basic attacks' });
  // Damage over time has no root spell. Its script names the item or augment.
  assert.deepEqual(names.label(key(0, '6653Burn', '6653Burn')), { group: 'item', name: "Liandry's Torment" });
  assert.deepEqual(names.label(key('ZyraQ', 'Augment_ARAM_MagicMissile_Missile1', 0)), { group: 'augment', name: 'Magic Missile' });
  assert.deepEqual(names.label(key('SnowballFollowupCast', 'SnowballFollowupCast', 0)), { group: 'summoner', name: 'Mark' });
  // Some item effects carry the raw item ID or only the origin.
  assert.deepEqual(names.label(key(fnvHash('SpellOriginItem'), 6653, 0)), { group: 'item', name: "Liandry's Torment" });
  assert.deepEqual(names.label(key(fnvHash('SpellOriginItem'), 0x0ef8db75, 0)), { group: 'item', name: 'Other item effects' });
  assert.deepEqual(names.label(key(0x0abcdef1, 0, 0)), { group: 'other', name: 'Other' });
  // A passive whose script name differs from the live ID still gets its name.
  names.addChampionNames(['ZyraPassiveSeed']);
  assert.deepEqual(names.label(key('ZyraPassiveSeed', 0, 0)), { group: 'ability', slot: 'P', name: 'Garden of Thorns', detail: 'Seed' });
  names.addItemNames([{ id: 2508, name: 'Fated Ashes' }]);
  assert.deepEqual(names.label(key(fnvHash('SpellOriginItem'), '2508', 0)), { group: 'item', name: 'Fated Ashes' });
});

test('combo spells keep their key sequence and unknown kit spells drop the champion name', () => {
  const names = new DamageSourceNames([]);
  names.updateLive({ activePlayer: { riotId: 'a', abilities: { Q: { id: 'HweiQ', displayName: 'Subject: Disaster' } } },
    allPlayers: [{ riotId: 'a', rawChampionName: 'game_character_displayname_Hwei' }] });
  names.addChampionNames(['HweiQE', 'HweiWE']);
  assert.deepEqual(names.label(key('HweiQE', 0, 0)), { group: 'ability', slot: 'Q', name: 'Subject: Disaster', detail: 'QE' });
  assert.deepEqual(names.label(key('HweiWE', 0, 0)), { group: 'ability', name: 'WE' });
});

test('merges sources that share a label and sorts by damage', () => {
  const names = new DamageSourceNames([]);
  names.updateLive(live);
  names.addChampionNames(['ZyraBasicAttack', 'ZyraBasicAttack2']);
  assert.deepEqual(labelSources([
    { name: key('ZyraBasicAttack', 0, 'ZyraBasicAttack'), amount: 10 },
    { name: key('ZyraQ', 'ZyraQ', 'ZyraQ'), amount: 25 },
    { name: key('ZyraBasicAttack2', 0, 'ZyraBasicAttack2'), amount: 20 },
    { name: 'Unknown source', amount: 1 }
  ], names), [
    { group: 'attack', slot: 'AA', name: 'Basic attacks', amount: 30 },
    { group: 'ability', slot: 'Q', name: 'Deadly Spines', amount: 25 },
    { group: 'other', name: 'Other', amount: 1 }
  ]);
});

test('reads script names from bin files in a game data archive', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-wad-'));
  const file = path.join(directory, 'Test.wad.client');
  const field = (name) => {
    const value = Buffer.from(name, 'latin1');
    const header = Buffer.alloc(7);
    header.writeUInt32LE(SCRIPT_NAME_FIELD);
    header[4] = 0x10;
    header.writeUInt16LE(value.length, 5);
    return Buffer.concat([header, value]);
  };
  const entries = [
    Buffer.concat([Buffer.from('PROP'), Buffer.alloc(12), field('TestQ'), Buffer.alloc(3), field('TestQMissile')]),
    Buffer.concat([Buffer.from('TEX\0'), field('NotABin')])
  ];
  const header = Buffer.alloc(272 + entries.length * 32);
  header.write('RW', 0, 'latin1');
  header[2] = 3; header[3] = 4;
  header.writeUInt32LE(entries.length, 268);
  let offset = header.length;
  entries.forEach((data, index) => {
    const entry = 272 + index * 32;
    header.writeUInt32LE(offset, entry + 8);
    header.writeUInt32LE(data.length, entry + 12);
    header.writeUInt32LE(data.length, entry + 16);
    offset += data.length;
  });
  fs.writeFileSync(file, Buffer.concat([header, ...entries]));
  try {
    assert.deepEqual([...await readWadScriptNames(file)], ['TestQ', 'TestQMissile']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
