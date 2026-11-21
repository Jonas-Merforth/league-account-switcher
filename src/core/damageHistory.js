import fs from 'node:fs';
import path from 'node:path';
import { DAMAGE_SESSION_ID } from './damageIpCapture.js';
import { fillFinalChampionNames } from './damageTeam.js';

function recordedGame(summary) {
  return !!summary.gameStartedAt || summary.samples > 0;
}

function readSummary(directory) {
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
    return summary && recordedGame(summary) ? { ...summary, sessionDirectory: directory, busy: false } : null;
  } catch { return null; }
}

function readSavedRoster(directory) {
  let fd;
  try {
    fd = fs.openSync(path.join(directory, 'observations.jsonl'), 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
    const count = fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    for (const line of buffer.toString('utf8', 0, count).trimEnd().split('\n').reverse()) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.kind === 'sample' && entry.data?.allPlayers?.length) return entry.data.allPlayers;
    }
  } catch { /* The previously saved summary can still be displayed. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

export class DamageHistory {
  constructor(directory) {
    this.directory = directory;
    this.revision = 0;
    this.finalByMatch = new Map();
  }
  saved(id, summary) {
    if (!recordedGame(summary)) return;
    if (summary.matchKey && summary.matchTotals) this.finalByMatch.set(summary.matchKey, id);
    if (!this.latestId || id > this.latestId) this.latestId = id;
    this.revision++;
    if (this.cached?.id === id || (summary.matchKey && this.cached?.summary?.matchKey === summary.matchKey)) this.cached = null;
  }
  list() {
    let entries;
    try { entries = fs.readdirSync(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const groups = new Map();
    this.finalByMatch.clear();
    this.indexed = true;
    const sessions = entries.filter((entry) => entry.isDirectory() && DAMAGE_SESSION_ID.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const { name: id } of sessions) {
      const summary = readSummary(path.join(this.directory, id));
      if (!summary) continue;
      if (summary.matchTotals && summary.matchKey && !this.finalByMatch.has(summary.matchKey)) {
        this.finalByMatch.set(summary.matchKey, id);
      }
      const local = summary.team?.teams?.flatMap((team) => team.players).find((player) => player.you);
      const startedAt = summary.gameStartedAt || summary.startedAt || id.substring(0, 24).replace(/T(\d{2})-(\d{2})-/, 'T$1:$2:');
      const champion = summary.championName || (local?.name === 'Unidentified champion' ? null : local?.name);
      const key = summary.matchKey || id;
      const segment = { id, startedAt };
      const game = groups.get(key);
      if (game) {
        game.recordings.push(segment);
        game.startedAt = startedAt;
        game.champion ||= champion;
      } else groups.set(key, { id, startedAt, champion, recordings: [segment] });
    }
    const games = [...groups.values()];
    this.latestId = games[0]?.id ?? null;
    return games;
  }
  read(id, target = 'all') {
    if (typeof id !== 'string' || !DAMAGE_SESSION_ID.test(id)) return null;
    if (this.cached?.id !== id) {
      const directory = path.join(this.directory, id);
      const summary = readSummary(directory);
      if (summary?.team?.source === 'matchHistory' && !summary.team.identified) {
        summary.team = fillFinalChampionNames(summary.team, summary.roster ?? readSavedRoster(directory));
      }
      this.cached = { id, summary };
    }
    const summary = this.cached.summary;
    if (!summary) return null;
    const { scopes, roster, ...view } = summary;
    if (target === 'champion') Object.assign(view, scopes?.champion || legacyChampionView(view));
    if (view.matchKey && !view.matchTotals) {
      // An early disconnect can exhaust its postgame retries before the game ends.
      if (!this.indexed) this.list();
      const otherId = this.finalByMatch.get(view.matchKey);
      if (otherId && this.cached.finalId !== otherId) {
        this.cached.final = readSummary(path.join(this.directory, otherId));
        this.cached.finalId = otherId;
      }
      const final = this.cached.final;
      if (final?.matchTotals) {
        view.matchTotals = Object.fromEntries(Object.entries(final.matchTotals).map(([scope, official]) => {
          const { total, types, duration, dps, fromMatchHistory, includesPracticeDummies } = official;
          const capture = scope === 'champion' ? scopes?.champion : summary;
          return [scope, withCapturedSources({ total, types, duration, dps, fromMatchHistory, includesPracticeDummies },
            capture?.meter?.total)];
        }));
        if (final.team?.state === 'final') view.team = final.team;
      }
    }
    return view;
  }
}

export function withCapturedSources(official, captured) {
  if (captured?.beforeRecording != null) {
    return { ...official, sources: captured.sources, beforeRecording: captured.beforeRecording,
      breakdownTotal: captured.total };
  }
  const matches = captured?.total != null && Math.trunc(captured.total) === official.total &&
    Object.entries(official.types).every(([type, amount]) => Math.trunc(captured.types[type]) === amount);
  return { ...official, sources: matches ? captured.sources : [], sourcesUnavailable: !matches && official.total > 0 };
}

// Older recordings saved the all-target breakdown and champion-only fights.
function legacyChampionView({ meter, dealt, matchTotals }) {
  const targets = (dealt?.targets || []).filter((row) => row.kind === 'champion');
  const total = targets.reduce((sum, row) => sum + row.amount, 0);
  const hits = targets.reduce((sum, row) => sum + row.hits, 0);
  const types = Object.fromEntries(Object.keys(dealt?.types || {}).map((key) =>
    [key, targets.reduce((sum, row) => sum + (row.types[key] || 0), 0)]));
  const scoped = { total, hits, types, targets, duration: dealt?.duration,
    dps: dealt?.duration > 0 ? total / dealt.duration : null };
  const hasCapturedTotal = dealt && meter?.total?.beforeRecording == null && !meter?.unclassifiedHits;
  return {
    dealt: dealt ? scoped : null,
    meter: meter && { ...meter, targetScope: 'Champions', total: hasCapturedTotal
      ? { ...scoped, sources: [], sourcesUnavailable: scoped.total > 0 } : null },
    ...(matchTotals?.champion || hasCapturedTotal ? {} : { meterStatus: 'This recording has additional detail under All targets.' })
  };
}
