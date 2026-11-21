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
  }
  saved(id, summary) {
    if (!recordedGame(summary)) return;
    if (!this.latestId || id > this.latestId) this.latestId = id;
    this.revision++;
    if (this.cached?.id === id) this.cached = null;
  }
  list() {
    let entries;
    try { entries = fs.readdirSync(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const games = entries.filter((entry) => entry.isDirectory() && DAMAGE_SESSION_ID.test(entry.name)).flatMap(({ name: id }) => {
      const summary = readSummary(path.join(this.directory, id));
      if (!summary) return [];
      const local = summary.team?.teams?.flatMap((team) => team.players).find((player) => player.you);
      const startedAt = summary.gameStartedAt || summary.startedAt || id.substring(0, 24).replace(/T(\d{2})-(\d{2})-/, 'T$1:$2:');
      const champion = summary.championName || (local?.name === 'Unidentified champion' ? null : local?.name);
      return [{ id, startedAt, champion }];
    }).sort((a, b) => b.id.localeCompare(a.id));
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
    if (target !== 'champion') return view;
    return { ...view, ...(scopes?.champion || legacyChampionView(view)) };
  }
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
