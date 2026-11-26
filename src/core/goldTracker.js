import { championModelName } from './damageSources.js';
import { matchPlayerIds, matchRoster } from './damageTeam.js';
import { LANE_LABELS, LANE_ORDER, normalizePosition, pairGoldMatchups } from './goldMatchups.js';

export { LANE_LABELS, LANE_ORDER, normalizePosition, pairGoldMatchups };

// Live gold estimation for every champion, anchored on spectator keyframe
// GOLD_EARNED totals and finalized from Match History when the game ends.
//
// League's Live Client Data API exposes the local player's exact unspent gold
// and every player's visible items, CS, KDA, lane position and game events,
// while withholding other players' unspent gold live. Between spectator
// keyframes (which carry exact GOLD_EARNED), this module estimates each
// player's live income from:
//   - exact local currentGold + purchased item deltas for the local player;
//   - passive gold over time (Summoner's Rift 20.4/10s from 1:50; ARAM 55/10s
//     from 1:00 plus ambient minion sharing);
//   - support item passive + quest charge income (World Atlas / Runic Compass);
//   - minion and jungle CS deltas scaled by match phase and role;
//   - champion kills, First Blood (+100g), assists, kill streaks and death
//     streak devaluation from live game events;
//   - turrets, First Turret (+300g), inhibitors, Dragons (+75g / Elder),
//     Rift Herald, Baron Nashor (+100g + 150g global) and Voidgrubs;
//   - a visible-inventory floor from LCU items.json priceTotal so hidden
//     income like turret plates is reflected as soon as players spend it.

// Free or quest-granted items that should not count as purchased gold.
const FREE_ITEM_IDS = new Set([2010, 2150, 2151, 2152, 2422, 3599, 3600]);
const CONSUMABLE_ITEM_IDS = new Set([2003, 2031, 2033, 2055, 2138, 2139, 2140]);
const SUPPORT_START_ITEMS = new Set([3865, 3866]);
const SUPPORT_FINAL_ITEMS = new Set([3867, 3869, 3870, 3871, 3876, 3877]);
const SUPPORT_BASE_COST = 400;
const SUPPORT_QUEST_CAP = 1200;
const BOT_QUEST_COMPLETE_TIME = 840;
const BOT_QUEST_LUMP_GOLD = 300;
const BOT_QUEST_TAKEDOWN_GOLD = 50;
// In League's Live Client Data API, enemy junglers' fog-of-war camps are
// omitted from scores.creepScore (~40-50% of true CS). Compensate while alive.
const ENEMY_JUNGLE_FOG_RATE = 1.4;
const ASSIGNED_ROLE_QUEUES = new Set([400, 420, 440, 480, 490, 700]);

// Kill streak shutdown bonus (2..7+ kills without dying) and death streak
// base-worth devaluation (0..6+ deaths without a kill).
const SHUTDOWN_BONUS = [0, 0, 100, 150, 300, 450, 600, 700];
const DEATH_STREAK_WORTH = [300, 274, 220, 176, 140, 112, 100];
const MAX_LEDGER_ENTRIES = 100_000;
const LATE_START_SECONDS = 90;

const teamCode = (team) => team === 'ORDER' || team === 100 ? 100 : team === 'CHAOS' || team === 200 ? 200 : null;
const isPlayer = (player, playerId) => !!playerId && (player?.riotId === playerId || player?.summonerName === playerId);

export function itemPriceMap(items) {
  if (!Array.isArray(items)) return null;
  const prices = new Map();
  for (const item of items) {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const total = Number.isFinite(item.priceTotal) ? item.priceTotal
      : Number.isFinite(item.price) ? item.price : null;
    if (total === null || total < 0) continue;
    const consumable = CONSUMABLE_ITEM_IDS.has(id) ||
      (Array.isArray(item.categories) && item.categories.includes('Consumable'));
    prices.set(id, { price: total, consumable });
  }
  return prices.size ? prices : null;
}

export function isAramGame(gameData) {
  const mode = String(gameData?.gameMode || '').toUpperCase();
  const mapName = String(gameData?.mapName || '');
  return ['ARAM', 'KIWI', 'FIRSTBLOOD'].includes(mode) || Number(gameData?.mapNumber) === 12 ||
    /howling|aram|abyss/i.test(mapName);
}

export function isMayhemGame(gameData) {
  return String(gameData?.gameMode || '').toUpperCase() === 'KIWI';
}

export function modeGoldRules(gameData) {
  const mayhem = isMayhemGame(gameData);
  const aram = isAramGame(gameData);
  if (aram) {
    // Verified against 16.22 and 16.23 ARAM Mayhem (KIWI) replays: baseline
    // passive income is 8.5 g/s from 1:00 and accelerates to 13.0 g/s at 13:00
    // (780 s), plus ambient nearby-minion sharing while alive.
    return {
      aram: true,
      mayhem,
      startingGold: 1400,
      passiveStart: 60,
      passiveRate: (time) => mayhem ? (time >= 780 ? 13.0 : 8.5) : 5.5,
      ambientMinionRate: (time) => mayhem && time >= 780 ? 2.0 : 1.5,
      firstBloodBonus: 100,
      baseKillWorth: () => 180,
      deathWorthScale: 180 / 300,
      assistPoolShare: () => 0.5,
      csValue: () => 20
    };
  }
  return {
    aram: false,
    mayhem: false,
    startingGold: 500,
    passiveStart: 110,
    passiveRate: () => 2.04,
    ambientMinionRate: () => 0,
    firstBloodBonus: 100,
    baseKillWorth: (level) => 300 + Math.max(0, Math.min(18, Number(level) || 1) - 6) * 10,
    deathWorthScale: 1,
    assistPoolShare: (time) => time >= 1200 ? 0.65 : 0.5,
    csValue: (time, position) => {
      if (position === 'JUNGLE') return time >= 840 ? 27.0 : 24.0;
      const base = time >= 1500 ? 27.5 : time >= 900 ? 23.0 : 21.0;
      return position === 'BOTTOM' && time >= BOT_QUEST_COMPLETE_TIME ? base + 2.0 : base;
    }
  };
}

function itemGoldBreakdown(items, prices, { forFloor = false } = {}) {
  if (!Array.isArray(items) || !prices?.size) return null;
  let equipment = 0;
  let consumables = 0;
  for (const item of items) {
    const id = Number(item?.itemID);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (forFloor && FREE_ITEM_IDS.has(id)) continue;
    const entry = prices.get(id);
    const rawUnit = typeof entry === 'number' ? entry : entry?.price;
    if (rawUnit == null) continue;
    const unit = SUPPORT_FINAL_ITEMS.has(id) || SUPPORT_START_ITEMS.has(id)
      ? Math.min(rawUnit, SUPPORT_BASE_COST) : rawUnit;
    const count = Number.isFinite(item.count) && item.count > 0 ? item.count : 1;
    const isConsumable = item.consumable === true || CONSUMABLE_ITEM_IDS.has(id) || !!entry?.consumable;
    if (isConsumable) consumables += unit * count;
    else equipment += unit * count;
  }
  return { total: equipment + consumables, equipment, consumables };
}

function supportItemStage(items) {
  if (!Array.isArray(items)) return 'none';
  for (const item of items) {
    const id = Number(item?.itemID);
    if (SUPPORT_FINAL_ITEMS.has(id)) return 'final';
    if (SUPPORT_START_ITEMS.has(id)) return 'quest';
  }
  return 'none';
}

function playerKeyFor(player) {
  if (typeof player?.riotId === 'string' && player.riotId) return player.riotId.toLowerCase();
  if (typeof player?.summonerName === 'string' && player.summonerName) return player.summonerName.toLowerCase();
  const team = teamCode(player?.team) || 0;
  const model = championModelName(player)?.toLowerCase() || String(player?.championName || '').toLowerCase();
  return `${team}:${model}`;
}

function eventNameAliases(player) {
  const names = new Set();
  for (const raw of [player?.riotId, player?.summonerName, player?.riotIdGameName]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const trimmed = raw.trim().toLowerCase();
    names.add(trimmed);
    const base = trimmed.split('#')[0].trim();
    if (base) names.add(base);
  }
  return names;
}

function turretReward(turretName, aram) {
  const name = String(turretName || '');
  // Verified against 16.22 ARAM Mayhem replays: Howling Abyss turrets pay ~200g global.
  if (aram) return { global: 200, local: 0 };
  if (/_T4_|Shrine/i.test(name)) return { global: 50, local: 0 };
  // Season 2026 outer, inner and inhibitor turrets carry 5 plates (~600g total local).
  if (/_T3_/i.test(name)) return { global: 50, local: 450 };
  if (/_T2_/i.test(name)) return { global: 50, local: 450 };
  return { global: 50, local: 450 };
}

function turretOwningTeam(turretName) {
  const name = String(turretName || '');
  if (/Turret_T1|Order/i.test(name)) return 100;
  if (/Turret_T2|Chaos/i.test(name)) return 200;
  return null;
}

function groupTeams(players, myTeam) {
  const teams = [];
  for (const side of ['ally', 'enemy']) {
    const members = players.filter((player) => myTeam == null ? side === 'ally' : (player.team === myTeam) === (side === 'ally'));
    if (members.length) teams.push({ side: myTeam == null ? 'unknown' : side, players: members });
  }
  return teams;
}

export class GoldTracker {
  constructor() {
    this.players = new Map();
    this.aliases = new Map();
    this.entries = [];
    this.seenEvents = new Set();
    this.itemPrices = null;
    this.rules = modeGoldRules(null);
    this.modeKnown = false;
    this.startedAt = null;
    this.lastGameTime = null;
    this.localKey = null;
    this.localState = null;
    this.firstBloodDone = false;
    this.firstTurretDone = false;
  }

  setItemPrices(prices) {
    if (prices instanceof Map && prices.size) this.itemPrices = prices;
    else if (Array.isArray(prices)) this.itemPrices = itemPriceMap(prices);
  }

  credit(key, time, amount, exact = false) {
    if (!key || !Number.isFinite(time) || !Number.isFinite(amount) || !(amount > 0)) return;
    if (this.entries.length >= MAX_LEDGER_ENTRIES) {
      // Collapse the oldest quarter into baseline totals if a session runs for hours.
      const cut = Math.floor(MAX_LEDGER_ENTRIES / 4);
      for (let i = 0; i < cut; i++) {
        const entry = this.entries[i];
        const player = this.players.get(entry.key);
        if (player) player.baseline += entry.amount;
      }
      this.entries.splice(0, cut);
    }
    this.entries.push({ key, time, amount, exact });
  }

  resolvePlayerKey(name) {
    if (typeof name !== 'string' || !name.trim()) return null;
    const lowered = name.trim().toLowerCase();
    return this.aliases.get(lowered) ?? this.aliases.get(lowered.split('#')[0].trim()) ?? null;
  }

  sample(data) {
    const gameTime = data?.gameData?.gameTime;
    if (!Number.isFinite(gameTime) || gameTime < 0) return;
    const allPlayers = Array.isArray(data.allPlayers) ? data.allPlayers : [];
    if (!allPlayers.length || allPlayers.length > 20) return;
    if (!this.modeKnown && (data.gameData?.gameMode || data.gameData?.mapNumber || data.gameData?.mapName)) {
      this.rules = modeGoldRules(data.gameData);
      this.modeKnown = true;
    }
    const previousTime = this.lastGameTime;
    const firstSample = this.startedAt === null;
    if (firstSample) this.startedAt = gameTime;
    const dt = previousTime === null ? 0 : Math.max(0, gameTime - previousTime);
    const active = data.activePlayer;

    for (let index = 0; index < allPlayers.length; index++) {
      const raw = allPlayers[index];
      const key = playerKeyFor(raw);
      const isMe = (active?.riotId && raw.riotId === active.riotId) ||
        (active?.summonerName && raw.summonerName === active.summonerName);
      if (isMe) this.localKey = key;
      for (const alias of eventNameAliases(raw)) this.aliases.set(alias, key);

      const cs = Number.isFinite(raw.scores?.creepScore) && raw.scores.creepScore >= 0 ? raw.scores.creepScore : 0;
      const kills = Number.isSafeInteger(raw.scores?.kills) ? raw.scores.kills : 0;
      const deaths = Number.isSafeInteger(raw.scores?.deaths) ? raw.scores.deaths : 0;
      const assists = Number.isSafeInteger(raw.scores?.assists) ? raw.scores.assists : 0;
      const position = normalizePosition(raw.position);
      const model = championModelName(raw)?.toLowerCase() || null;
      const itemSummary = itemGoldBreakdown(raw.items, this.itemPrices, { forFloor: false });
      const floorSummary = itemGoldBreakdown(raw.items, this.itemPrices, { forFloor: true });
      const itemGold = itemSummary ? itemSummary.total : null;
      const floorItemGold = floorSummary ? floorSummary.total : null;
      const supportStage = supportItemStage(raw.items);

      let player = this.players.get(key);
      if (!player) {
        const baseline = this.initialBaseline(gameTime, { cs, kills, assists, position, supportStage, floorItemGold,
          currentGold: isMe ? active?.currentGold : null, late: gameTime > LATE_START_SECONDS });
        player = {
          key,
          name: typeof raw.championName === 'string' && raw.championName ? raw.championName.slice(0, 40) : 'Unidentified champion',
          model,
          team: teamCode(raw.team),
          position,
          you: !!isMe,
          rosterIndex: index,
          level: Number.isFinite(raw.level) ? raw.level : 1,
          isDead: !!raw.isDead,
          kills, deaths, assists, cs,
          itemGold,
          floorItemGold,
          currentGold: isMe && Number.isFinite(active?.currentGold) ? active.currentGold : null,
          supportStage,
          supportQuestGold: Math.min(SUPPORT_QUEST_CAP, supportStage === 'final' ? SUPPORT_QUEST_CAP : 0),
          botQuestPaid: !this.rules.aram && position === 'BOTTOM' && gameTime >= BOT_QUEST_COMPLETE_TIME,
          killStreak: 0,
          deathStreak: 0,
          baseline
        };
        this.players.set(key, player);
      } else {
        if (typeof raw.championName === 'string' && raw.championName) player.name = raw.championName.slice(0, 40);
        if (model) player.model = model;
        if (teamCode(raw.team)) player.team = teamCode(raw.team);
        if (position) player.position = position;
        if (isMe) player.you = true;
        if (gameTime >= 1) player.rosterIndex = index;
        if (Number.isFinite(raw.level)) player.level = raw.level;
        player.isDead = !!raw.isDead;
        player.kills = kills;
        player.deaths = deaths;
        player.assists = assists;
        player.supportStage = supportStage;
        if (itemGold !== null) player.itemGold = itemGold;
        if (floorItemGold !== null) player.floorItemGold = floorItemGold;
        if (isMe && Number.isFinite(active?.currentGold)) player.currentGold = active.currentGold;

        // Non-local players accrue estimated passive, support and CS deltas.
        if (!isMe || !this.localState) {
          this.accrueTick(player, previousTime, gameTime, dt, cs);
        }
        player.cs = cs;
      }

      if (isMe) this.trackLocalGold(player, gameTime, active?.currentGold, floorSummary);
    }

    this.processEvents(data.events?.Events, gameTime);
    this.lastGameTime = Math.max(this.lastGameTime ?? 0, gameTime);
  }

  initialBaseline(gameTime, { cs, kills, assists, position, supportStage, floorItemGold, currentGold, late }) {
    const rules = this.rules;
    const passiveTime = Math.max(0, gameTime - rules.passiveStart);
    let passiveTotal = 0;
    if (rules.mayhem && gameTime > 780) {
      passiveTotal = (780 - rules.passiveStart) * rules.passiveRate(700) + (gameTime - 780) * rules.passiveRate(800);
    } else {
      passiveTotal = passiveTime * rules.passiveRate(gameTime);
    }
    let total = rules.startingGold + passiveTotal;
    if (late) {
      total += passiveTime * rules.ambientMinionRate(gameTime);
      total += cs * rules.csValue(gameTime, position);
      total += kills * rules.baseKillWorth(10);
      total += assists * (rules.baseKillWorth(10) * 0.4);
      if (supportStage === 'final') total += SUPPORT_QUEST_CAP + passiveTime * 0.4;
      else if (supportStage === 'quest' || position === 'UTILITY') total += Math.min(SUPPORT_QUEST_CAP, passiveTime * 0.85) + passiveTime * 0.3;
    }
    const floor = (floorItemGold ?? 0) + (Number.isFinite(currentGold) && currentGold >= 0 ? currentGold : 0);
    return Math.max(total, floor);
  }

  accrueTick(player, previousTime, gameTime, dt, newCs) {
    const rules = this.rules;
    const myTeam = this.localKey ? this.players.get(this.localKey)?.team : null;
    if (dt > 0 && gameTime > rules.passiveStart) {
      const effectiveStart = Math.max(previousTime ?? 0, rules.passiveStart);
      const passiveDt = Math.max(0, gameTime - effectiveStart);
      if (passiveDt > 0) {
        let rate = rules.passiveRate(gameTime);
        const ambient = rules.ambientMinionRate(gameTime);
        if (!player.isDead && ambient > 0) rate += ambient;
        const isSupport = !rules.aram && (player.supportStage !== 'none' || player.position === 'UTILITY');
        if (isSupport) {
          const questActive = player.supportStage === 'quest' ||
            (player.supportStage === 'none' && player.supportQuestGold < SUPPORT_QUEST_CAP);
          if (questActive && player.supportQuestGold < SUPPORT_QUEST_CAP) {
            rate += 0.3;
            const questGain = Math.min(SUPPORT_QUEST_CAP - player.supportQuestGold, passiveDt * 1.15);
            player.supportQuestGold += questGain;
            this.credit(player.key, gameTime, questGain, false);
          } else {
            rate += 0.7;
          }
        }
        // Enemy junglers' fog-of-war camps are omitted from live scores.creepScore.
        if (!rules.aram && player.position === 'JUNGLE' && !player.isDead &&
            myTeam != null && player.team != null && player.team !== myTeam) {
          rate += ENEMY_JUNGLE_FOG_RATE;
        }
        this.credit(player.key, gameTime, passiveDt * rate, false);
      }
    }
    if (!rules.aram && player.position === 'BOTTOM' && !player.botQuestPaid && gameTime >= BOT_QUEST_COMPLETE_TIME) {
      player.botQuestPaid = true;
      this.credit(player.key, gameTime, BOT_QUEST_LUMP_GOLD, false);
    }
    const dCs = newCs - player.cs;
    if (dCs > 0 && dCs <= 50) {
      this.credit(player.key, gameTime, dCs * rules.csValue(gameTime, player.position), false);
    }
  }

  // For the local player, currentGold + purchasedItemGold captures every gold
  // source exactly (passive, CS, plates, kills, assists, objectives) while
  // ignoring purchases, undos, sales and consumable use.
  trackLocalGold(player, gameTime, currentGold, floorSummary) {
    if (!Number.isFinite(currentGold) || currentGold < 0 || !floorSummary) return;
    if (!this.localState) {
      this.localState = { currentGold, equipment: floorSummary.equipment, consumables: floorSummary.consumables };
      if (gameTime <= LATE_START_SECONDS) {
        player.baseline = Math.max(player.baseline, currentGold + floorSummary.total);
      }
      return;
    }
    const dGold = currentGold - this.localState.currentGold;
    const dEquip = floorSummary.equipment - this.localState.equipment;
    // Buying a consumable spends gold; drinking/placing it yields no refund.
    const dConsPurchase = Math.max(0, floorSummary.consumables - this.localState.consumables);
    const dItem = dEquip + dConsPurchase;
    // If an item appeared without spending gold (quest reward / free item),
    // do not count the item jump as earned gold.
    const earned = dItem > 0 && dGold >= 0 ? Math.max(0, dGold) : Math.max(0, dGold + dItem);
    if (earned > 0) this.credit(player.key, gameTime, earned, true);
    this.localState = { currentGold, equipment: floorSummary.equipment, consumables: floorSummary.consumables };
  }

  processEvents(events, currentGameTime) {
    if (!Array.isArray(events) || !events.length) return;
    const rules = this.rules;
    for (const event of events) {
      const id = event?.EventID;
      if (id == null || this.seenEvents.has(id)) continue;
      this.seenEvents.add(id);
      const time = Number.isFinite(event.EventTime) ? event.EventTime : currentGameTime;
      const kind = event.EventName;
      // On a late start, events that happened before our first sample are
      // already reflected in the initial baseline; still update streaks.
      const beforeTracking = this.startedAt > LATE_START_SECONDS && time < this.startedAt - 0.5;

      if (kind === 'ChampionKill') {
        const killerKey = this.resolvePlayerKey(event.KillerName);
        const victimKey = this.resolvePlayerKey(event.VictimName);
        const assisterKeys = (Array.isArray(event.Assisters) ? event.Assisters : [])
          .map((name) => this.resolvePlayerKey(name)).filter((key) => key && key !== killerKey);
        const victim = victimKey ? this.players.get(victimKey) : null;
        const killer = killerKey ? this.players.get(killerKey) : null;
        const baseWorth = victim?.deathStreak > 0
          ? DEATH_STREAK_WORTH[Math.min(victim.deathStreak, DEATH_STREAK_WORTH.length - 1)] * rules.deathWorthScale
          : rules.baseKillWorth(victim?.level);
        const shutdown = victim?.killStreak >= 2
          ? SHUTDOWN_BONUS[Math.min(victim.killStreak, SHUTDOWN_BONUS.length - 1)] * rules.deathWorthScale
          : 0;
        if (!beforeTracking && killerKey) {
          const killerBotBonus = !rules.aram && killer?.position === 'BOTTOM' && time >= BOT_QUEST_COMPLETE_TIME
            ? BOT_QUEST_TAKEDOWN_GOLD : 0;
          if (killerKey !== this.localKey || !this.localState) {
            this.credit(killerKey, time, baseWorth + shutdown + killerBotBonus, false);
          }
          if (assisterKeys.length) {
            const perAssist = (baseWorth * rules.assistPoolShare(time)) / assisterKeys.length;
            for (const key of assisterKeys) {
              const assister = this.players.get(key);
              const botBonus = !rules.aram && assister?.position === 'BOTTOM' && time >= BOT_QUEST_COMPLETE_TIME
                ? BOT_QUEST_TAKEDOWN_GOLD : 0;
              if (key !== this.localKey || !this.localState) this.credit(key, time, perAssist + botBonus, false);
            }
          }
        }
        if (killer) { killer.killStreak++; killer.deathStreak = 0; }
        if (victim) { victim.killStreak = 0; victim.deathStreak++; }
      } else if (kind === 'FirstBlood') {
        if (!this.firstBloodDone) {
          this.firstBloodDone = true;
          const recipientKey = this.resolvePlayerKey(event.Recipient);
          if (!beforeTracking && recipientKey && (recipientKey !== this.localKey || !this.localState)) {
            this.credit(recipientKey, time, rules.firstBloodBonus, false);
          }
        }
      } else if (kind === 'TurretKilled') {
        if (beforeTracking) continue;
        const killerKey = this.resolvePlayerKey(event.KillerName);
        const assisterKeys = (Array.isArray(event.Assisters) ? event.Assisters : [])
          .map((name) => this.resolvePlayerKey(name)).filter(Boolean);
        const participants = [...new Set([killerKey, ...assisterKeys].filter(Boolean))];
        const destroyerTeam = (killerKey && this.players.get(killerKey)?.team) ||
          (turretOwningTeam(event.TurretKilled) === 100 ? 200 : turretOwningTeam(event.TurretKilled) === 200 ? 100 : null);
        const { global: globalGold, local: localGold } = turretReward(event.TurretKilled, rules.aram);
        if (destroyerTeam && globalGold > 0) this.creditTeam(destroyerTeam, time, globalGold);
        if (participants.length && localGold > 0) {
          const share = localGold / participants.length;
          for (const key of participants) {
            if (key !== this.localKey || !this.localState) this.credit(key, time, share, false);
          }
        }
      } else if (kind === 'FirstBrick') {
        if (!this.firstTurretDone) {
          this.firstTurretDone = true;
          if (beforeTracking || rules.aram) continue;
          const killerKey = this.resolvePlayerKey(event.KillerName);
          if (killerKey && (killerKey !== this.localKey || !this.localState)) {
            this.credit(killerKey, time, 300, false);
          }
        }
      } else if (kind === 'InhibKilled') {
        const killerKey = this.resolvePlayerKey(event.KillerName);
        if (!beforeTracking && killerKey && (killerKey !== this.localKey || !this.localState)) {
          this.credit(killerKey, time, 50, false);
        }
      } else if (kind === 'DragonKill') {
        if (beforeTracking) continue;
        const killerKey = this.resolvePlayerKey(event.KillerName);
        const killerTeam = killerKey ? this.players.get(killerKey)?.team : null;
        if (String(event.DragonType || '').toLowerCase() === 'elder') {
          if (killerKey && (killerKey !== this.localKey || !this.localState)) this.credit(killerKey, time, 100, false);
          if (killerTeam) this.creditTeam(killerTeam, time, 150);
        } else if (killerKey && (killerKey !== this.localKey || !this.localState)) {
          this.credit(killerKey, time, 75, false);
        }
      } else if (kind === 'HeraldKill') {
        if (beforeTracking) continue;
        const killerKey = this.resolvePlayerKey(event.KillerName);
        const assisterKeys = (Array.isArray(event.Assisters) ? event.Assisters : [])
          .map((name) => this.resolvePlayerKey(name)).filter(Boolean);
        const participants = [...new Set([killerKey, ...assisterKeys].filter(Boolean))];
        if (killerKey && (killerKey !== this.localKey || !this.localState)) this.credit(killerKey, time, 100, false);
        if (participants.length) {
          const share = 100 / participants.length;
          for (const key of participants) {
            if (key !== this.localKey || !this.localState) this.credit(key, time, share, false);
          }
        }
      } else if (kind === 'BaronKill') {
        if (beforeTracking) continue;
        const killerKey = this.resolvePlayerKey(event.KillerName);
        const killerTeam = killerKey ? this.players.get(killerKey)?.team : null;
        if (killerKey && (killerKey !== this.localKey || !this.localState)) this.credit(killerKey, time, 100, false);
        if (killerTeam) this.creditTeam(killerTeam, time, 150);
      } else if (kind === 'HordeKill') {
        const killerKey = this.resolvePlayerKey(event.KillerName);
        if (!beforeTracking && killerKey && (killerKey !== this.localKey || !this.localState)) {
          this.credit(killerKey, time, 30, false);
        }
      } else if (kind === 'AtakhanKill') {
        const killerKey = this.resolvePlayerKey(event.KillerName);
        if (!beforeTracking && killerKey && (killerKey !== this.localKey || !this.localState)) {
          this.credit(killerKey, time, 100, false);
        }
      }
    }
  }

  creditTeam(team, time, amount) {
    for (const player of this.players.values()) {
      if (player.team !== team) continue;
      if (player.key !== this.localKey || !this.localState) this.credit(player.key, time, amount, false);
    }
  }

  // Gold accumulated strictly after `sinceTime` (or all tracked entries when -Infinity).
  since(sinceTime = -Infinity) {
    const totals = new Map();
    for (const entry of this.entries) {
      if (!(entry.time > sinceTime)) continue;
      let bucket = totals.get(entry.key);
      if (!bucket) totals.set(entry.key, bucket = { amount: 0, exact: true });
      bucket.amount += entry.amount;
      if (!entry.exact) bucket.exact = false;
    }
    return totals;
  }

  snapshot({ anchor, roster, playerId, heroModels, gameTime } = {}) {
    const hasAnchorGold = anchor?.heroes?.size > 0 && Number.isFinite(anchor.gameTime) &&
      [...anchor.heroes.values()].every((hero) => Number.isFinite(hero.goldEarned) && hero.goldEarned > 0);
    if (hasAnchorGold) {
      const anchored = this.fromAnchor(anchor, { roster, playerId, heroModels, gameTime });
      if (anchored) return anchored;
    }
    if (!this.players.size) return null;
    const live = this.since(-Infinity);
    const me = [...this.players.values()].find((player) => player.you);
    const myTeam = me?.team ?? teamCode(roster?.find((player) => isPlayer(player, playerId))?.team);
    const rows = [...this.players.values()].map((player) => {
      const delta = live.get(player.key);
      const rawTotal = player.baseline + (delta?.amount || 0);
      const floor = (player.floorItemGold ?? 0) + (player.you && player.currentGold != null ? player.currentGold : 0);
      const gold = Math.round(Math.max(rawTotal, floor));
      const exactLocal = player.you && !!this.localState && this.startedAt <= LATE_START_SECONDS;
      const unspent = player.you && player.currentGold != null ? Math.round(player.currentGold)
        : player.itemGold != null ? Math.max(0, gold - Math.round(player.itemGold)) : null;
      return {
        name: player.name,
        team: player.team,
        you: player.you,
        position: player.position,
        gold,
        itemGold: player.itemGold != null ? Math.round(player.itemGold) : null,
        unspent,
        estimated: !exactLocal,
        kills: player.kills,
        deaths: player.deaths,
        assists: player.assists,
        cs: player.cs
      };
    });
    return {
      source: 'live',
      gameTime: gameTime ?? this.lastGameTime ?? null,
      behind: null,
      liveSince: this.startedAt ?? 0,
      identified: true,
      teams: groupTeams(rows, myTeam)
    };
  }

  fromAnchor(anchor, { roster, playerId, heroModels, gameTime } = {}) {
    const ids = [...anchor.heroes.keys()];
    const matched = matchRoster(ids, roster, heroModels);
    const named = matched && matched.every((player, index) => teamCode(player?.team) === anchor.heroes.get(ids[index]).team);
    const sinceAnchor = this.since(anchor.gameTime);
    const hasLive = this.lastGameTime !== null && this.lastGameTime > anchor.gameTime + 0.5;
    const rows = ids.map((id, index) => {
      const stats = anchor.heroes.get(id);
      const rosterPlayer = named ? matched[index] : null;
      const key = rosterPlayer ? playerKeyFor(rosterPlayer) : null;
      const livePlayer = key ? this.players.get(key) : null;
      const confirmed = stats.goldEarned;
      const delta = key && hasLive ? sinceAnchor.get(key) : null;
      const rawTotal = confirmed + (delta?.amount || 0);
      const floor = hasLive && livePlayer
        ? (livePlayer.floorItemGold ?? 0) + (livePlayer.you && livePlayer.currentGold != null ? livePlayer.currentGold : 0)
        : 0;
      const gold = Math.round(Math.max(rawTotal, floor));
      const livePart = Math.max(0, gold - Math.round(confirmed));
      const exactLocal = !!livePlayer?.you && !!this.localState;
      const estimated = hasLive && livePart > 0 && !exactLocal;
      const itemGold = livePlayer?.itemGold != null ? Math.round(livePlayer.itemGold)
        : Number.isFinite(stats.goldSpent) ? Math.round(stats.goldSpent) : null;
      const unspent = livePlayer?.you && livePlayer.currentGold != null ? Math.round(livePlayer.currentGold)
        : itemGold != null ? Math.max(0, gold - itemGold) : null;
      return {
        name: livePlayer?.name || rosterPlayer?.championName?.slice(0, 40) || 'Unidentified champion',
        team: stats.team,
        you: !!rosterPlayer && isPlayer(rosterPlayer, playerId),
        position: livePlayer?.position || normalizePosition(rosterPlayer?.position),
        gold,
        confirmedGold: Math.round(confirmed),
        liveGold: livePart,
        itemGold,
        unspent,
        estimated,
        kills: livePlayer?.kills ?? stats.kills,
        deaths: livePlayer?.deaths ?? stats.deaths,
        assists: livePlayer?.assists ?? stats.assists,
        cs: livePlayer?.cs ?? null
      };
    });
    const me = named ? rows.find((row) => row.you) : null;
    const myTeam = me?.team ?? teamCode(roster?.find((player) => isPlayer(player, playerId))?.team);
    return {
      source: 'spectator',
      keyFrameId: anchor.keyFrameId ?? null,
      gameTime: anchor.gameTime,
      behind: Number.isFinite(gameTime) ? Math.max(0, gameTime - anchor.gameTime) : null,
      ...(hasLive && { liveSince: anchor.gameTime }),
      identified: !!named,
      teams: groupTeams(rows, myTeam)
    };
  }
}

// Final Match History gold totals for every player, preserving lane positions.
export function goldFromMatch(match, { roster, playerId, championNames } = {}) {
  const identities = new Map((match?.participantIdentities || []).map(({ participantId, player }) => [participantId, matchPlayerIds(player)]));
  const localId = playerId?.toLowerCase();
  const rows = [];
  for (const participant of match?.participants || []) {
    const stats = participant?.stats;
    if (!stats || ![100, 200].includes(participant.teamId)) return null;
    const goldEarned = Number.isSafeInteger(stats.goldEarned) && stats.goldEarned >= 0 ? stats.goldEarned : null;
    if (goldEarned === null) return null;
    const goldSpent = Number.isSafeInteger(stats.goldSpent) && stats.goldSpent >= 0 ? stats.goldSpent : null;
    const ids = identities.get(participant.participantId) || [];
    const rosterPlayer = roster?.find((entry) => teamCode(entry.team) === participant.teamId &&
      matchPlayerIds(entry).some((id) => ids.includes(id)));
    const name = championNames?.get(Number(participant.championId)) || rosterPlayer?.championName;
    const assignedSlot = match?.participants?.length === 10 &&
      (ASSIGNED_ROLE_QUEUES.has(Number(match.queueId)) || (match.mapId === 11 && match.gameMode === 'CLASSIC'))
      ? LANE_ORDER[(participant.participantId - 1) % 5] : null;
    const directPos = normalizePosition(participant.teamPosition || participant.individualPosition || rosterPlayer?.position);
    const timelinePos = normalizePosition(null, participant.timeline);
    const position = directPos || (timelinePos === 'JUNGLE' && assignedSlot === 'TOP' ? 'TOP' : timelinePos) || assignedSlot;
    const amount = (key) => Number.isSafeInteger(stats[key]) && stats[key] >= 0 ? stats[key] : 0;
    rows.push({
      name: name?.slice(0, 40) || 'Unidentified champion',
      team: participant.teamId,
      you: ids.includes(localId),
      position,
      gold: goldEarned,
      confirmedGold: goldEarned,
      liveGold: 0,
      itemGold: goldSpent,
      unspent: goldSpent != null ? Math.max(0, goldEarned - goldSpent) : null,
      estimated: false,
      kills: amount('kills'),
      deaths: amount('deaths'),
      assists: amount('assists'),
      cs: amount('totalMinionsKilled') + amount('neutralMinionsKilled')
    });
  }
  const me = rows.filter((row) => row.you);
  if (me.length !== 1) return null;
  return {
    source: 'matchHistory',
    state: 'final',
    identified: rows.every((row) => row.name !== 'Unidentified champion'),
    teams: groupTeams(rows, me[0].team)
  };
}
