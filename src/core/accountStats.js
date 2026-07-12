import fs from 'node:fs';
import path from 'node:path';
import { getSwitcherStatsPath } from './config.js';
import { gameQueueDescriptor } from './queueLabels.js';

export const ACCOUNT_STATS_VERSION = 1;

export class LoginObservationTracker {
  constructor() {
    this.currentAccountId = null;
  }

  observe(accountId, { force = false } = {}) {
    const id = String(accountId || '').trim();
    if (!id) {
      this.currentAccountId = null;
      return false;
    }
    const shouldCount = force || this.currentAccountId !== id;
    this.currentAccountId = id;
    return shouldCount;
  }
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function normalizeGames(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const games = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key || !value || typeof value !== 'object') continue;
    const count = nonNegativeInteger(value.count);
    if (!count) continue;
    games[key] = {
      label: String(value.label || key).trim() || key,
      count,
      queueId: value.queueId !== null && value.queueId !== undefined && String(value.queueId).trim()
        && Number.isFinite(Number(value.queueId))
        ? Number(value.queueId)
        : null,
      type: value.type ? String(value.type) : null,
      gameMode: value.gameMode ? String(value.gameMode) : null
    };
  }
  return games;
}

export function normalizeAccountStats(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const accounts = {};
  const rawAccounts = source.accounts && typeof source.accounts === 'object' && !Array.isArray(source.accounts)
    ? source.accounts
    : {};
  for (const [accountId, value] of Object.entries(rawAccounts)) {
    if (!accountId || !value || typeof value !== 'object') continue;
    accounts[accountId] = {
      loginCount: nonNegativeInteger(value.loginCount),
      gamesByQueue: normalizeGames(value.gamesByQueue),
      lastCountedGameId: value.lastCountedGameId ? String(value.lastCountedGameId) : null
    };
  }
  return { version: ACCOUNT_STATS_VERSION, accounts };
}

export function loadAccountStats({ log = () => {} } = {}) {
  try {
    return normalizeAccountStats(JSON.parse(fs.readFileSync(getSwitcherStatsPath(), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') log(`Stats: could not read statistics; starting at zero (${error.message}).`, 'warn');
    return normalizeAccountStats();
  }
}

export function saveAccountStats(stats) {
  const normalized = normalizeAccountStats(stats);
  const target = getSwitcherStatsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function ensureRecord(stats, accountId) {
  stats.accounts[accountId] ??= { loginCount: 0, gamesByQueue: {}, lastCountedGameId: null };
  return stats.accounts[accountId];
}

export function incrementLoginCount(input, accountId) {
  const stats = normalizeAccountStats(input);
  const id = String(accountId || '').trim();
  if (!id) return { stats, changed: false };
  ensureRecord(stats, id).loginCount += 1;
  return { stats, changed: true };
}

export function recordStartedGame(input, accountId, game = {}) {
  const stats = normalizeAccountStats(input);
  const id = String(accountId || '').trim();
  const gameId = String(game.gameId || '').trim();
  if (!id || !gameId) return { stats, changed: false, duplicate: false, queue: null };
  const record = ensureRecord(stats, id);
  if (record.lastCountedGameId === gameId) return { stats, changed: false, duplicate: true, queue: null };
  const queue = gameQueueDescriptor(game.queue || {});
  const existing = record.gamesByQueue[queue.key] || { label: queue.label, count: 0 };
  record.gamesByQueue[queue.key] = {
    label: queue.label || existing.label,
    count: existing.count + 1,
    queueId: queue.queueId,
    type: queue.type,
    gameMode: queue.gameMode
  };
  record.lastCountedGameId = gameId;
  return { stats, changed: true, duplicate: false, queue };
}

export function removeAccountStatistics(input, accountId) {
  const stats = normalizeAccountStats(input);
  const id = String(accountId || '').trim();
  if (!id || !Object.hasOwn(stats.accounts, id)) return { stats, changed: false };
  delete stats.accounts[id];
  return { stats, changed: true };
}

export function accountStatsSummary(input, accounts = [], orderIds = []) {
  const stats = normalizeAccountStats(input);
  const order = new Map(orderIds.map((id, index) => [String(id), index]));
  const layoutOrder = (a, b) => {
    const aRank = order.get(String(a.id));
    const bRank = order.get(String(b.id));
    if (Number.isInteger(aRank) || Number.isInteger(bRank)) {
      if (!Number.isInteger(aRank)) return 1;
      if (!Number.isInteger(bRank)) return -1;
      if (aRank !== bRank) return aRank - bRank;
    }
    return String(a.label || '').localeCompare(String(b.label || ''));
  };
  const summaries = accounts.map((account) => {
    const record = stats.accounts[account.id] || { loginCount: 0, gamesByQueue: {} };
    const queues = Object.entries(record.gamesByQueue)
      .map(([key, value]) => ({
        key,
        label: value.label,
        count: value.count,
        queueId: value.queueId,
        type: value.type,
        gameMode: value.gameMode
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return {
      accountId: account.id,
      label: account.label,
      loginCount: record.loginCount,
      totalGames: queues.reduce((sum, queue) => sum + queue.count, 0),
      queues
    };
  });
  summaries.sort((a, b) => {
    const gameDelta = b.totalGames - a.totalGames;
    if (gameDelta !== 0) return gameDelta;
    return layoutOrder(
      { id: a.accountId, label: a.label },
      { id: b.accountId, label: b.label }
    );
  });
  return {
    accounts: summaries
  };
}
