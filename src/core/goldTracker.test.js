import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoldTracker, goldFromMatch, itemPriceMap, normalizePosition, pairGoldMatchups } from './goldTracker.js';
import { heroStatFields } from './heroStats.js';
import { DamageRecorder } from './damageRecorder.js';

const ITEMS_CATALOG = [
  { id: 1055, name: "Doran's Blade", price: 450, priceTotal: 450 },
  { id: 2003, name: 'Health Potion', price: 50, priceTotal: 50 },
  { id: 1036, name: 'Long Sword', price: 350, priceTotal: 350 },
  { id: 1038, name: 'B. F. Sword', price: 1300, priceTotal: 1300 },
  { id: 3031, name: 'Infinity Edge', price: 1225, priceTotal: 3400 },
  { id: 2422, name: 'Slightly Magical Footwear', price: 300, priceTotal: 300 },
  { id: 3865, name: 'World Atlas', price: 400, priceTotal: 400 },
  { id: 3877, name: 'Bloodsong', price: 0, priceTotal: 400 },
  { id: 3340, name: 'Stealth Ward', price: 0, priceTotal: 0 }
];
const PRICES = itemPriceMap(ITEMS_CATALOG);

function makePlayer(name, team, position, overrides = {}) {
  return {
    riotId: `${name}#EUW`,
    riotIdGameName: name,
    summonerName: name,
    championName: name,
    rawChampionName: `game_character_displayname_${name}`,
    team,
    position,
    level: 6,
    isDead: false,
    scores: { kills: 0, deaths: 0, assists: 0, creepScore: 0, wardScore: 0 },
    items: [],
    ...overrides
  };
}

test('local player tracks exact gold across earning, buying, upgrading, selling, consumables and free items', () => {
  const tracker = new GoldTracker();
  tracker.setItemPrices(PRICES);
  const sample = (gameTime, currentGold, items) => tracker.sample({
    gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime },
    activePlayer: { riotId: 'Ahri#EUW', currentGold },
    allPlayers: [makePlayer('Ahri', 'ORDER', 'MIDDLE', { items }), makePlayer('Zed', 'CHAOS', 'MIDDLE')]
  });

  // Start at 500g unspent.
  sample(10, 500, []);
  const me = () => tracker.snapshot().teams[0].players.find((p) => p.you);
  assert.equal(me().gold, 500);
  assert.equal(me().unspent, 500);
  assert.equal(me().estimated, false);

  // Buy Doran's Blade (450g) + Health Potion (50g): net earned stays 500g.
  sample(15, 0, [{ itemID: 1055, count: 1 }, { itemID: 2003, count: 1 }]);
  assert.equal(me().gold, 500);
  assert.equal(me().itemGold, 500);
  assert.equal(me().unspent, 0);

  // Drink Health Potion while earning 1300g: earned rises by 1300g, not distorted by lost potion.
  sample(180, 1300, [{ itemID: 1055, count: 1 }]);
  assert.equal(me().gold, 1800);

  // Buy B. F. Sword (1300g): total gold earned stays 1800g.
  sample(185, 0, [{ itemID: 1055, count: 1 }, { itemID: 1038, count: 1 }]);
  assert.equal(me().gold, 1800);

  // Receive free Slightly Magical Footwear (2422) + 50g passive: only +50g earned.
  sample(210, 50, [{ itemID: 1055, count: 1 }, { itemID: 1038, count: 1 }, { itemID: 2422, count: 1 }]);
  assert.equal(me().gold, 1850);

  // Sell Doran's Blade (450g -> 180g refund): must not count refund as new gold earned.
  sample(215, 230, [{ itemID: 1038, count: 1 }, { itemID: 2422, count: 1 }]);
  assert.equal(me().gold, 1850);

  // Earn 2100g, then upgrade BF Sword (1300) + 2100g -> Infinity Edge (3400): total rises by 2100g.
  sample(300, 2330, [{ itemID: 1038, count: 1 }, { itemID: 2422, count: 1 }]);
  assert.equal(me().gold, 3950);
  sample(305, 230, [{ itemID: 3031, count: 1 }, { itemID: 2422, count: 1 }]);
  assert.equal(me().gold, 3950);
});

test('estimates passive, CS, kills, assists, bounties, objectives, support items and item floor for all players', () => {
  const tracker = new GoldTracker();
  tracker.setItemPrices(PRICES);
  const players = [
    makePlayer('Garen', 'ORDER', 'TOP'),
    makePlayer('LeeSin', 'ORDER', 'JUNGLE'),
    makePlayer('Ahri', 'ORDER', 'MIDDLE'),
    makePlayer('Jinx', 'ORDER', 'BOTTOM'),
    makePlayer('Thresh', 'ORDER', 'UTILITY', { items: [{ itemID: 3865, count: 1 }] }),
    makePlayer('Darius', 'CHAOS', 'TOP'),
    makePlayer('Viego', 'CHAOS', 'JUNGLE'),
    makePlayer('Zed', 'CHAOS', 'MIDDLE'),
    makePlayer('Caitlyn', 'CHAOS', 'BOTTOM'),
    makePlayer('Nautilus', 'CHAOS', 'UTILITY')
  ];
  const byName = (name) => tracker.snapshot().teams.flatMap((t) => t.players).find((p) => p.name === name);

  tracker.sample({ gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 110 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 500 }, allPlayers: players, events: { Events: [] } });
  assert.equal(byName('Garen').gold, 500);
  assert.equal(byName('LeeSin').gold, 500);

  // Advance 100s (110 -> 210): passive 204g; Garen +10 lane CS (+210g); LeeSin +8 jungle CS (+192g);
  // Thresh holds World Atlas (+30g passive + 115g quest); Garen gets First Blood on Darius with LeeSin assist;
  // LeeSin kills Elemental Dragon (+75g) and Rift Herald (+200g solo).
  players[0].scores.creepScore = 10;
  players[1].scores.creepScore = 8;
  tracker.sample({
    gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 210 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 704 },
    allPlayers: players,
    events: { Events: [
      { EventID: 1, EventName: 'ChampionKill', EventTime: 180, KillerName: 'Garen', VictimName: 'Darius', Assisters: ['LeeSin'] },
      { EventID: 2, EventName: 'FirstBlood', EventTime: 180, Recipient: 'Garen' },
      { EventID: 3, EventName: 'DragonKill', EventTime: 200, DragonType: 'Fire', KillerName: 'LeeSin', Assisters: [] },
      { EventID: 4, EventName: 'HeraldKill', EventTime: 205, KillerName: 'LeeSin', Assisters: [] }
    ] }
  });

  assert.equal(byName('Garen').gold, Math.round(500 + 204 + 210 + 300 + 100));
  assert.equal(byName('LeeSin').gold, Math.round(500 + 204 + 192 + 150 + 75 + 200));
  assert.equal(byName('Thresh').gold, Math.round(500 + 204 + 30 + 115));
  assert.equal(byName('Darius').gold, Math.round(500 + 204));
  // Enemy jungler (Viego) also receives fog-of-war camp compensation (+1.4 g/s while alive).
  assert.equal(byName('Viego').gold, Math.round(500 + 204 + 140));

  // Hidden plate income spent on an Infinity Edge (3400g) lifts Darius's floor immediately.
  players[5].items = [{ itemID: 3031, count: 1 }];
  tracker.sample({
    gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 220 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 724 },
    allPlayers: players,
    events: { Events: [] }
  });
  assert.equal(byName('Darius').gold, 3400);
  assert.equal(byName('Darius').itemGold, 3400);
});

test('retroactively anchors gold to spectator keyframes and keeps only post-keyframe live income', () => {
  const tracker = new GoldTracker();
  tracker.setItemPrices(PRICES);
  const roster = [
    makePlayer('Ahri', 'ORDER', 'MIDDLE'),
    makePlayer('Zed', 'CHAOS', 'MIDDLE')
  ];
  tracker.sample({ gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 110 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 500 }, allPlayers: roster });
  // At 120s (keyframe time), Zed gets 10 CS (+205g) and 10s passive (+20.4g).
  roster[1].scores.creepScore = 10;
  tracker.sample({ gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 120 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 520 }, allPlayers: roster });
  // At 150s (after keyframe), Zed gets 10 more CS (+205g), 30s passive (+61.2g), and kills Ahri (+300g).
  roster[1].scores.creepScore = 20;
  tracker.sample({
    gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 150 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 581 },
    allPlayers: roster,
    events: { Events: [{ EventID: 10, EventName: 'ChampionKill', EventTime: 140, KillerName: 'Zed', VictimName: 'Ahri', Assisters: [] }] }
  });

  // Spectator keyframe at 120s says Zed actually had 2000g (e.g. had extra turret plates before 120s).
  const anchor = {
    keyFrameId: 2,
    gameTime: 120,
    heroes: new Map([
      [0x40000001, { team: 100, kills: 0, deaths: 0, assists: 0, goldEarned: 1500, goldSpent: 450 }],
      [0x40000002, { team: 200, kills: 0, deaths: 0, assists: 0, goldEarned: 2000, goldSpent: 1300 }]
    ])
  };
  const anchored = tracker.snapshot({ anchor, roster, playerId: 'Ahri#EUW', gameTime: 150 });
  assert.equal(anchored.source, 'spectator');
  assert.equal(anchored.liveSince, 120);
  assert.equal(anchored.behind, 30);
  const ahri = anchored.teams[0].players[0];
  const zed = anchored.teams[1].players[0];
  assert.equal(ahri.confirmedGold, 1500);
  assert.equal(ahri.gold, 1561); // 1500 confirmed + exact 61g earned after 120s
  assert.equal(ahri.estimated, false);
  assert.equal(zed.confirmedGold, 2000);
  assert.equal(zed.gold, Math.round(2000 + 61.2 + 210 + 300));
  assert.equal(zed.estimated, true);
});

test('goldFromMatch fixes LCU Match History tagging Top laners as JUNGLE', () => {
  const champs = ['Garen', 'LeeSin', 'Ahri', 'Jinx', 'Thresh', 'Darius', 'Viego', 'Zed', 'Caitlyn', 'Lulu'];
  const match = {
    mapId: 11,
    gameMode: 'CLASSIC',
    queueId: 420,
    participantIdentities: champs.map((name, i) => ({ participantId: i + 1, player: { gameName: name, tagLine: 'EUW' } })),
    participants: champs.map((name, i) => ({
      participantId: i + 1,
      teamId: i < 5 ? 100 : 200,
      timeline: {
        // Reproduce LCU Match History reporting lane=JUNGLE for both Top and Jungle slots.
        lane: [0, 1, 5, 6].includes(i) ? 'JUNGLE' : [2, 7].includes(i) ? 'MIDDLE' : 'BOTTOM',
        role: [4, 9].includes(i) ? 'SUPPORT' : [3, 8].includes(i) ? 'CARRY' : 'NONE'
      },
      stats: { goldEarned: 10000 + i * 100, goldSpent: 9000, kills: 1, deaths: 1, assists: 1, totalMinionsKilled: 100, neutralMinionsKilled: 0 }
    }))
  };
  const view = goldFromMatch(match, {
    roster: champs.map((name, i) => ({ riotId: `${name}#EUW`, championName: name, team: i < 5 ? 'ORDER' : 'CHAOS' })),
    playerId: 'Ahri#EUW'
  });
  const paired = pairGoldMatchups(view.teams);
  assert.equal(paired.hasLanes, true);
  assert.deepEqual(paired.rows.map((r) => [r.laneLabel, r.ally.name, r.enemy.name]), [
    ['Top', 'Garen', 'Darius'],
    ['Jgl', 'LeeSin', 'Viego'],
    ['Mid', 'Ahri', 'Zed'],
    ['Bot', 'Jinx', 'Caitlyn'],
    ['Sup', 'Thresh', 'Lulu']
  ]);
});

test('reads goldEarned and goldSpent from hero stat vectors and rejects invalid values safely', () => {
  const vector = Buffer.alloc(1260);
  vector.writeUInt32LE(100, 0x20);
  vector.writeFloatLE(4250.5, 0x34);
  vector.writeFloatLE(5120.25, 0x38);
  const stats = heroStatFields(vector);
  assert.equal(stats.goldSpent, 4250.5);
  assert.equal(stats.goldEarned, 5120.25);

  // A uint32 integer (5000) written where a float32 is expected reads as a subnormal and is ignored.
  const bad = Buffer.alloc(1260);
  bad.writeUInt32LE(100, 0x20);
  bad.writeUInt32LE(5000, 0x38);
  const parsed = heroStatFields(bad);
  assert.equal(parsed.goldEarned, undefined);
});

test('pairs Summoner’s Rift lanes head-to-head and falls back to gold rank on ARAM', () => {
  const srTeams = [
    { side: 'ally', players: [
      { name: 'Thresh', position: 'UTILITY', gold: 7100, you: false },
      { name: 'Ahri', position: 'MIDDLE', gold: 10500, you: true },
      { name: 'Garen', position: 'TOP', gold: 9800, you: false },
      { name: 'Jinx', position: 'BOTTOM', gold: 11200, you: false },
      { name: 'Lee Sin', position: 'JUNGLE', gold: 9200, you: false }
    ] },
    { side: 'enemy', players: [
      { name: 'Zed', position: 'MIDDLE', gold: 9900, you: false },
      { name: 'Darius', position: 'TOP', gold: 10100, you: false },
      { name: 'Viego', position: 'JUNGLE', gold: 8800, you: false },
      { name: 'Caitlyn', position: 'BOTTOM', gold: 10900, you: false },
      { name: 'Nautilus', position: 'UTILITY', gold: 6800, you: false }
    ] }
  ];
  const paired = pairGoldMatchups(srTeams);
  assert.equal(paired.hasLanes, true);
  assert.deepEqual(paired.rows.map((r) => [r.laneLabel, r.ally.name, r.enemy.name, r.diff, r.isYou]), [
    ['Top', 'Garen', 'Darius', -300, false],
    ['Jgl', 'Lee Sin', 'Viego', 400, false],
    ['Mid', 'Ahri', 'Zed', 600, true],
    ['Bot', 'Jinx', 'Caitlyn', 300, false],
    ['Sup', 'Thresh', 'Nautilus', 300, false]
  ]);

  const aram = pairGoldMatchups([
    { side: 'ally', players: [{ name: 'Sona', position: null, gold: 8000, you: false }, { name: 'Lux', position: null, gold: 11000, you: true }] },
    { side: 'enemy', players: [{ name: 'Zyra', position: null, gold: 9500, you: false }, { name: 'Jhin', position: null, gold: 12000, you: false }] }
  ]);
  assert.equal(aram.hasLanes, false);
  assert.deepEqual(aram.rows.map((r) => [r.laneLabel, r.ally.name, r.enemy.name, r.diff, r.isYou]), [
    ['#1', 'Lux', 'Jhin', -1000, true],
    ['#2', 'Sona', 'Zyra', -1500, false]
  ]);
});

test('uses ARAM rules for ARAM / ARAM Mayhem and finalizes gold from Match History via DamageRecorder', async () => {
  const aramTracker = new GoldTracker();
  aramTracker.sample({
    gameData: { gameMode: 'KIWI', mapNumber: 12, gameTime: 60 },
    activePlayer: { riotId: 'Lux#EUW', currentGold: 1400 },
    allPlayers: [makePlayer('Lux', 'ORDER', 'NONE'), makePlayer('Zyra', 'CHAOS', 'NONE')]
  });
  aramTracker.sample({
    gameData: { gameMode: 'KIWI', mapNumber: 12, gameTime: 70 },
    activePlayer: { riotId: 'Lux#EUW', currentGold: 1455 },
    allPlayers: [makePlayer('Lux', 'ORDER', 'NONE'), makePlayer('Zyra', 'CHAOS', 'NONE')]
  });
  // 1400 start + 10s * (8.5 Mayhem passive + 1.5 ambient minion) = 1500g for alive non-local player.
  assert.equal(aramTracker.snapshot().teams[1].players[0].gold, 1500);
  // After 13:00 (780s), ARAM Mayhem passive accelerates to 13.0 g/s + 2.0 g/s ambient.
  aramTracker.sample({
    gameData: { gameMode: 'KIWI', mapNumber: 12, gameTime: 780 },
    activePlayer: { riotId: 'Lux#EUW', currentGold: 7400 },
    allPlayers: [makePlayer('Lux', 'ORDER', 'NONE'), makePlayer('Zyra', 'CHAOS', 'NONE')]
  });
  const at780 = aramTracker.snapshot().teams[1].players[0].gold;
  aramTracker.sample({
    gameData: { gameMode: 'KIWI', mapNumber: 12, gameTime: 790 },
    activePlayer: { riotId: 'Lux#EUW', currentGold: 7530 },
    allPlayers: [makePlayer('Lux', 'ORDER', 'NONE'), makePlayer('Zyra', 'CHAOS', 'NONE')]
  });
  assert.equal(aramTracker.snapshot().teams[1].players[0].gold - at780, 150);

  assert.equal(normalizePosition('', { lane: 'BOTTOM', role: 'DUO_SUPPORT' }), 'UTILITY');
  assert.equal(normalizePosition('MID'), 'MIDDLE');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-gold-match-'));
  const log = path.join(root, 'game_r3dlog.txt');
  fs.writeFileSync(log, 'GameStartData::GameID=555\r\n');
  const startedAt = Date.now();
  let capture, resolveMatch;
  const recorder = new DamageRecorder({
    directory: root,
    leaguePath: () => root,
    readItems: async () => ITEMS_CATALOG,
    readChampions: async () => [{ id: 103, name: 'Ahri' }, { id: 238, name: 'Zed' }],
    readGame: async () => ({
      gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 300 },
      activePlayer: { riotId: 'Ahri#EUW', currentGold: 650 },
      allPlayers: [makePlayer('Ahri', 'ORDER', 'MIDDLE'), makePlayer('Zed', 'CHAOS', 'MIDDLE')]
    }),
    readMatch: () => new Promise((resolve) => { resolveMatch = resolve; }),
    captureFactory: ({ onUpdate }) => (capture = {
      busy: false,
      start() { this.busy = true; onUpdate({ state: 'capturing', gameStartedAt: new Date(startedAt).toISOString() }); },
      stop() { this.busy = false; onUpdate({ state: 'complete', gameStartedAt: new Date(startedAt).toISOString() }); }
    })
  });
  try {
    recorder.start('next');
    recorder.logSource = log;
    await recorder.poll();
    assert.equal(recorder.snapshot().gold.source, 'live');
    assert.equal(recorder.snapshot().gold.teams[0].players[0].position, 'MIDDLE');

    capture.stop();
    await recorder.poll();
    resolveMatch({
      gameId: 555,
      gameCreation: startedAt,
      gameDuration: 900,
      participantIdentities: [
        { participantId: 1, player: { gameName: 'Ahri', tagLine: 'EUW' } },
        { participantId: 2, player: { gameName: 'Zed', tagLine: 'EUW' } }
      ],
      participants: [
        { participantId: 1, teamId: 100, championId: 103, teamPosition: 'MIDDLE',
          stats: { totalDamageDealtToChampions: 10000, goldEarned: 11200, goldSpent: 10400, kills: 5, deaths: 1, assists: 4, totalMinionsKilled: 140, neutralMinionsKilled: 8 } },
        { participantId: 2, teamId: 200, championId: 238, teamPosition: 'MIDDLE',
          stats: { totalDamageDealtToChampions: 9000, goldEarned: 9800, goldSpent: 9200, kills: 3, deaths: 4, assists: 2, totalMinionsKilled: 120, neutralMinionsKilled: 4 } }
      ]
    });
    await new Promise((resolve) => setImmediate(resolve));
    const finalGold = recorder.snapshot().gold;
    assert.equal(finalGold.source, 'matchHistory');
    assert.equal(finalGold.state, 'final');
    assert.equal(finalGold.teams[0].players[0].gold, 11200);
    assert.equal(finalGold.teams[0].players[0].position, 'MIDDLE');
    assert.equal(finalGold.teams[1].players[0].gold, 9800);
    const [saved] = recorder.history.list();
    assert.equal(recorder.history.read(saved.id).gold.teams[0].players[0].gold, 11200);
  } finally {
    await recorder.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps SR kill gold flat by level, recovers death streak on assists, counts TF passive and tracks sunk gold', () => {
  const tracker = new GoldTracker();
  tracker.setItemPrices(PRICES);
  const players = [
    makePlayer('Ahri', 'ORDER', 'MIDDLE', { level: 18 }),
    makePlayer('Lux', 'ORDER', 'UTILITY', { level: 18 }),
    makePlayer('TwistedFate', 'CHAOS', 'MIDDLE', { level: 18, items: [{ itemID: 1055, count: 1 }, { itemID: 2003, count: 1 }] })
  ];
  const byName = (name) => tracker.snapshot().teams.flatMap((t) => t.players).find((p) => p.name === name);

  tracker.sample({
    gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 110 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 500 },
    allPlayers: players,
    events: { Events: [] }
  });

  // Level-18 kill on SR pays flat 300g base, not level-scaled 420g.
  // Twisted Fate gets 10 CS (+210g base + 40g Loaded Dice passive = +250g).
  // Twisted Fate drinks Health Potion (50g) and sells Doran's Blade (270g sell loss -> 320g sunkGold).
  players[2].scores.creepScore = 10;
  players[2].items = [];
  tracker.sample({
    gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 110 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 550 },
    allPlayers: players,
    events: { Events: [
      { EventID: 1, EventName: 'ChampionKill', EventTime: 110, KillerName: 'Lux', VictimName: 'TwistedFate', Assisters: [] }
    ] }
  });
  assert.equal(byName('Lux').gold, 500 + 300);
  assert.equal(byName('TwistedFate').gold, 500 + 250);
  // Sunk gold (50g potion + 270g starter sell loss) reduces estimated unspent gold and preserves the floor.
  assert.equal(byName('TwistedFate').unspent, 750 - 320);

  // Two deaths push TF to deathStreak 2; an assist recovers it back to 1 (worth 274g instead of 220g).
  tracker.sample({
    gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 110 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 550 },
    allPlayers: players,
    events: { Events: [
      { EventID: 2, EventName: 'ChampionKill', EventTime: 110, KillerName: 'Lux', VictimName: 'TwistedFate', Assisters: [] },
      { EventID: 3, EventName: 'ChampionKill', EventTime: 110, KillerName: 'Ahri', VictimName: 'Lux', Assisters: ['TwistedFate'] },
      { EventID: 4, EventName: 'ChampionKill', EventTime: 110, KillerName: 'Lux', VictimName: 'TwistedFate', Assisters: [] }
    ] }
  });
  // Lux got 300 (kill 1) + 274 (kill 2 at deathStreak 1) + 274 (kill 4 after assist dropped deathStreak 2 -> 1).
  assert.equal(byName('Lux').gold, 500 + 300 + 274 + 274);

  // Local player buying a 50g Health Potion while earning 100g in the same 1s sample (dGold = +50) keeps full +100g earned.
  players[0].items = [{ itemID: 2003, count: 1 }];
  tracker.sample({
    gameData: { gameMode: 'CLASSIC', mapNumber: 11, gameTime: 111 },
    activePlayer: { riotId: 'Ahri#EUW', currentGold: 600 },
    allPlayers: players,
    events: { Events: [] }
  });
  assert.equal(byName('Ahri').gold, 650);
});
