import fs from 'node:fs';
import path from 'node:path';
import { decompress } from 'fzstd';
import { SHARED_SOURCE_NAMES } from './damageSourceNames16_22.js';

// Damage events identify spells by the lowercase ELF hash of the spell's
// script name. Item and rune origins use an FNV-1a hash of the origin name.
export function elfHash(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    hash = ((hash << 4) + (code >= 65 && code <= 90 ? code + 32 : code)) >>> 0;
    const high = hash & 0xf0000000;
    if (high) hash = ((hash ^ (high >>> 24)) & ~high) >>> 0;
  }
  return hash;
}

export function fnvHash(name) {
  let hash = 0x811c9dc5;
  for (const char of name.toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash;
}

const ITEM_ORIGIN = fnvHash('SpellOriginItem');
const RUNE_ORIGIN = fnvHash('SpellOriginPerk');
export const SCRIPT_NAME_FIELD = fnvHash('mScriptName');
export const RUNE_SCRIPT_FIELD = 0x2c13bd72;
const STRING_TYPE = 0x10;
const SUMMONER_ALIASES = new Map([['snowballfollowupcast', 'SummonerSnowball'], ['porosnowballmissile', 'SummonerSnowball']]);
const BASIC_ATTACK = /(?:basic|crit)attack\d*$/i;
const RUNE_SCRIPT = /^ASSETS\/Perks\/Styles\/[A-Za-z]+\/[A-Za-z0-9_]+\/([A-Za-z0-9_]+)\.lua$/;
// Multiple Mayhem augments apply the same burn script.
const MAYHEM_SHARED_BURN = elfHash('Augment_ARAM_SlowCooker_Bleed');
const MAYHEM_BURN_AUGMENTS = new Map([[1036, 'Firebrand'], [1045, 'Infernal Conduit'], [1075, 'Slow Cooker']]);
const yieldToEvents = () => new Promise((resolve) => setImmediate(resolve));

// Reads string values of the given property fields from the bin files in a
// version 3 WAD archive. Other entries are skipped.
export async function readWadScriptNames(file, { fields = [SCRIPT_NAME_FIELD], maxEntries = 20000,
  maxEntrySize = 2 * 1024 * 1024, maxNames = 50000 } = {}) {
  const needles = fields.map((field) => {
    const needle = Buffer.alloc(5);
    needle.writeUInt32LE(field);
    needle[4] = STRING_TYPE;
    return needle;
  });
  const handle = await fs.promises.open(file, 'r');
  const names = new Set();
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(272);
    await handle.read(header, 0, header.length, 0);
    if (header.toString('latin1', 0, 2) !== 'RW' || header[2] !== 3) throw new Error('Unsupported game data archive');
    const count = header.readUInt32LE(268);
    if (count > maxEntries || 272 + count * 32 > fileSize) throw new Error('Invalid game data archive');
    const table = Buffer.alloc(count * 32);
    await handle.read(table, 0, table.length, 272);
    let sliceStart = Date.now();
    for (let i = 0; i < count && names.size < maxNames; i++) {
      const entry = i * 32;
      const offset = table.readUInt32LE(entry + 8);
      const stored = table.readUInt32LE(entry + 12);
      const size = table.readUInt32LE(entry + 16);
      const type = table[entry + 20] & 15;
      if (![0, 3].includes(type) || size > maxEntrySize || stored > maxEntrySize || offset + stored > fileSize) continue;
      const raw = Buffer.alloc(stored);
      await handle.read(raw, 0, stored, offset);
      let data = raw;
      if (type === 3) {
        try { data = Buffer.from(decompress(raw, new Uint8Array(size))); } catch { continue; }
      }
      const magic = data.toString('latin1', 0, 4);
      if (magic === 'PROP' || magic === 'PTCH') collectStrings(data, needles, names);
      if (Date.now() - sliceStart > 8) { await yieldToEvents(); sliceStart = Date.now(); }
    }
  } finally { await handle.close(); }
  return names;
}

function collectStrings(data, needles, names) {
  for (const needle of needles) {
    for (let at = data.indexOf(needle); at >= 0; at = data.indexOf(needle, at + 1)) {
      if (at + 7 > data.length) break;
      const length = data.readUInt16LE(at + 5);
      if (!length || length > 200 || at + 7 + length > data.length) continue;
      const value = data.toString('latin1', at + 7, at + 7 + length);
      if (/^[\x21-\x7e]+$/.test(value)) names.add(value);
    }
  }
}

const championCache = new Map();
// Champion spell names, including pets and sub-spells, come from the
// installed champion archive. Results are cached per archive version.
export async function readChampionScriptNames(leaguePath, model) {
  if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(model || '')) throw new Error('Invalid champion name');
  const file = path.join(leaguePath, 'Game', 'DATA', 'FINAL', 'Champions', `${model}.wad.client`);
  const stat = await fs.promises.stat(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (!championCache.has(key)) {
    const pending = readWadScriptNames(file);
    championCache.set(key, pending);
    pending.catch(() => championCache.delete(key));
  }
  return championCache.get(key);
}

export function humanizeName(name) {
  return name.replace(/_+/g, ' ').replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

const augmentName = (name) =>
  humanizeName(name.replace(/^Augment_/i, '').replace(/^(?:ARAM|Kiwi|Cherry|Arena)_/i, '').split('_')[0]);
const detailName = (rest) => humanizeName(rest.replace(/(?:Missile|Damage|Dmg|Spell|Cast)\d*$/i, ''));
const generatedId = (raw, kind) => new RegExp(`^GeneratedTip_${kind}_([A-Za-z0-9_]+)_DisplayName$`).exec(raw || '')?.[1];
const SLOTS = { Q: 'Q', W: 'W', E: 'E', R: 'R', Passive: 'P' };

// Turns the three spell hashes of a damage event into a friendly label.
export class DamageSourceNames {
  constructor(shared = SHARED_SOURCE_NAMES) {
    this.names = new Map();
    for (const name of shared) this.names.set(elfHash(name), name);
    this.championNames = new Set();
    this.model = null;
    this.abilities = new Map();
    this.summoners = new Map();
    this.items = new Map();
    this.runes = new Map();
  }
  addChampionNames(names) {
    for (const name of names) {
      // The player's own kit wins the rare collision with a shared name.
      this.names.set(elfHash(name), name);
      this.championNames.add(name.toLowerCase());
    }
  }
  // Some item effects name their spell after the bare item ID.
  addItemNames(items) {
    for (const { id, name } of Array.isArray(items) ? items : []) {
      if (!Number.isSafeInteger(id) || id < 1000 || id > 999999 || typeof name !== 'string' || !name.trim()) continue;
      this.items.set(id, name.trim().slice(0, 80));
      const hash = elfHash(String(id));
      if (!this.names.has(hash)) this.names.set(hash, String(id));
    }
  }
  updateLive(data) {
    const active = data?.activePlayer;
    const me = (data?.allPlayers || []).find((player) =>
      (active?.riotId && player.riotId === active.riotId) || (active?.summonerName && player.summonerName === active.summonerName));
    const model = /^game_character_displayname_([A-Za-z0-9]+)$/.exec(me?.rawChampionName || '')?.[1];
    if (model) this.model = model;
    for (const [slot, ability] of Object.entries(active?.abilities || {})) {
      const id = typeof ability?.id === 'string' && ability.id ? ability.id
        : generatedId(ability?.rawDisplayName, slot === 'Passive' ? 'Passive' : 'Spell');
      if (!SLOTS[slot] || !/^[A-Za-z0-9_]{1,80}$/.test(id || '') || typeof ability.displayName !== 'string') continue;
      this.abilities.set(id.toLowerCase(), { slot: SLOTS[slot], name: ability.displayName.slice(0, 80) });
      this.addChampionNames([id]);
    }
    for (const spell of Object.values(me?.summonerSpells || {})) {
      const id = generatedId(spell?.rawDisplayName, 'SummonerSpell');
      if (id && typeof spell.displayName === 'string') this.summoners.set(id.toLowerCase(), spell.displayName.slice(0, 80));
    }
    this.addItemNames((me?.items || []).map((item) => ({ id: item?.itemID, name: item?.displayName })));
    const runes = active?.fullRunes;
    for (const rune of [runes?.keystone, ...(runes?.generalRunes || [])]) {
      if (typeof rune?.displayName !== 'string') continue;
      const key = generatedId(rune.rawDisplayName, 'Perk') || rune.displayName;
      this.runes.set(key.replace(/[^A-Za-z0-9]/g, '').toLowerCase(), rune.displayName.slice(0, 80));
    }
  }
  setMatchAugments(gameMode, ids) {
    const candidates = gameMode === 'KIWI' ? [...new Set(ids)].filter((id) => MAYHEM_BURN_AUGMENTS.has(id)) : [];
    this.burnAugment = candidates.length === 1 ? MAYHEM_BURN_AUGMENTS.get(candidates[0]) : null;
  }
  describe(hash) {
    if (!hash) return null;
    if (hash === MAYHEM_SHARED_BURN) return { kind: 'augment', name: this.burnAugment || 'Burn' };
    if (hash === ITEM_ORIGIN) return { kind: 'itemOrigin' };
    if (hash === RUNE_ORIGIN) return { kind: 'runeOrigin' };
    const name = this.names.get(hash);
    if (!name) return null;
    const lower = name.toLowerCase();
    const itemId = /^(\d{4,6})(?![\d])/.exec(name)?.[1];
    if (itemId) return { kind: 'item', id: Number(itemId) };
    if (lower.startsWith('augment_')) return { kind: 'augment', name: augmentName(name) };
    const rune = RUNE_SCRIPT.exec(name)?.[1];
    if (rune) return { kind: 'rune', name: rune };
    const summoner = SUMMONER_ALIASES.get(lower) || (lower.startsWith('summoner') ? name : null);
    if (summoner) return { kind: 'summoner', name: summoner };
    if (this.championNames.has(lower) || (this.model && lower.startsWith(this.model.toLowerCase()))) return { kind: 'champion', name };
    return { kind: 'other', name };
  }
  // The key is "root:script:missile" in hex, as stored on tracked events.
  label(key) {
    const [root, script, missile] = String(key).split(':').map((part) => Number.parseInt(part, 16));
    const describedRoot = this.describe(root);
    const describedScript = this.describe(script);
    const describedMissile = this.describe(missile);
    const effect = (described) => ['item', 'augment', 'rune'].includes(described?.kind);
    if (effect(describedScript)) return this.present(describedScript);
    if (describedRoot && !['itemOrigin', 'runeOrigin'].includes(describedRoot.kind)) return this.present(describedRoot);
    if (describedRoot?.kind === 'itemOrigin' && this.items.has(script)) return this.present({ kind: 'item', id: script });
    if (effect(describedMissile)) return this.present(describedMissile);
    if (describedRoot?.kind === 'itemOrigin') return { group: 'item', name: 'Other item effects' };
    if (describedRoot?.kind === 'runeOrigin') return { group: 'rune', name: 'Runes' };
    for (const described of [describedScript, describedMissile]) {
      if (described?.kind === 'champion' || described?.kind === 'summoner') return this.present(described);
    }
    return { group: 'other', name: 'Other' };
  }
  present(described) {
    switch (described.kind) {
      case 'item': return { group: 'item', name: this.items.get(described.id) || `Item ${described.id}` };
      case 'augment': return { group: 'augment', name: described.name || 'Augment' };
      case 'rune': {
        const key = described.name.replace(/Temp$/, '').toLowerCase();
        return { group: 'rune', name: this.runes.get(key) || humanizeName(described.name.replace(/Temp$/, '')) };
      }
      case 'summoner': {
        const id = described.name.toLowerCase();
        return { group: 'summoner', name: this.summoners.get(id) || humanizeName(described.name.replace(/^Summoner/i, '')) };
      }
      case 'champion': return this.presentChampion(described.name);
      default: return { group: 'other', name: humanizeName(described.name) };
    }
  }
  presentChampion(name) {
    const lower = name.toLowerCase();
    if (BASIC_ATTACK.test(lower) && !this.abilities.has(lower)) return { group: 'attack', slot: 'AA', name: 'Basic attacks' };
    let best = null;
    for (const [id, ability] of this.abilities) {
      // Sub-spells continue the ID at a CamelCase boundary, as in ZyraQPlant.
      const boundary = name.length === id.length || /[A-Z0-9_]/.test(name.charAt(id.length));
      if (lower.startsWith(id) && boundary && (!best || id.length > best.id.length)) best = { id, ...ability };
    }
    const model = this.model?.toLowerCase();
    if (!best && model && lower.startsWith(`${model}passive`)) {
      const passive = [...this.abilities.values()].find((ability) => ability.slot === 'P');
      best = { id: `${model}passive`, slot: 'P', name: passive?.name || 'Passive' };
    }
    if (best) {
      const rest = name.slice(best.id.length);
      // Combo spells such as HweiQE keep their key sequence.
      const detail = /^[QWER]$/i.test(rest) ? `${best.slot}${rest.toUpperCase()}` : detailName(rest);
      return { group: 'ability', slot: best.slot, name: best.name, ...(detail && { detail }) };
    }
    const own = model && lower.startsWith(model) && lower.length > model.length ? name.slice(model.length) : name;
    return { group: 'ability', name: humanizeName(own) };
  }
}

// Relabel and merge tracker source totals for display.
export function labelSources(sources, names) {
  const merged = new Map();
  for (const { name, amount } of sources) {
    const label = name === 'Unknown source' ? { group: 'other', name: 'Other' } : names.label(name);
    const key = `${label.group}:${label.slot || ''}:${label.name}:${label.detail || ''}`;
    const entry = merged.get(key);
    if (entry) entry.amount += amount;
    else merged.set(key, { ...label, amount });
  }
  return [...merged.values()].sort((a, b) => b.amount - a.amount);
}
