// Replays finished development recordings in arrival order. Spectator observations
// serve as the answers only after the estimate at each game-time boundary is frozen.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DamageLive } from '../src/core/damageLive.js';
import { DamageHistory } from '../src/core/damageHistory.js';

const ACTIVE_DAMAGE = 300;
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const stat = (frame, id) => frame.heroes.get(id)?.damageToChampions.total;
const rounded = value => value == null ? 'n/a' : Math.round(value);
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

export function scoringWindows(frames) {
  const windows = [];
  // A chunk and a keyframe can describe the same boundary a millisecond apart.
  const boundaries = new Map();
  const seen = new Set();
  for (const frame of frames) {
    const slot = Math.round(frame.gameTime / 30);
    if (!frame.rejected && (!boundaries.has(slot) || frame.chunkId == null)) boundaries.set(slot, frame);
    if (!Array.isArray(frame.championHits) || frame.rejected !== 0 ||
        !Number.isFinite(frame.hitsFrom) || seen.has(frame.chunkId)) continue;
    seen.add(frame.chunkId);
    // Only score full five-second windows inside a single known-good chunk.
    for (let to = (Math.ceil(frame.hitsFrom / 5) + 1) * 5; to <= frame.gameTime; to += 5) {
      const hits = frame.championHits.filter(([time]) => time > to - 5 && time <= to);
      const exact = new Map([...frame.heroes.keys()].map(id => [id, 0]));
      for (const [, source, , amount] of hits) exact.set(source, exact.get(source) + amount);
      windows.push({ from: to - 5, to, exact, hits });
    }
  }
  for (const [slot, frame] of boundaries) {
    const prev = boundaries.get(slot - 1);
    if (!prev || Math.abs(frame.gameTime - prev.gameTime - 30) > 1 ||
        prev.heroes.size !== frame.heroes.size || [...frame.heroes.keys()].some(id => !prev.heroes.has(id))) continue;
    const exact = new Map([...frame.heroes.keys()].map(id => [id, stat(frame, id) - stat(prev, id)]));
    windows.push({ from: prev.gameTime, to: frame.gameTime, exact, frame });
  }
  return windows.sort((a, b) => a.to - b.to);
}

function scores() {
  return { active: 0, leaders: 0, errors: [], overlay: [], stale: [], worst: null };
}

function score(bucket, window, live, anchor) {
  const { owner, teamLive } = live;
  if (!owner || live.ownerConflict || !teamLive.teams.has(owner)) return;
  const allies = [...window.exact.keys()].filter(id => teamLive.teams.get(id) === teamLive.teams.get(owner));
  const confirmedLead = Math.max(...allies.map(id => window.exact.get(id)));
  if (confirmedLead < ACTIVE_DAMAGE) return;
  const estimate = teamLive.since(window.from, window.to);
  const estimated = id => estimate.get(id)?.champion ?? 0;
  const leader = allies.reduce((a, b) => estimated(a) >= estimated(b) ? a : b);
  bucket.active++;
  if (window.exact.get(leader) === confirmedLead) bucket.leaders++;
  const overlay = window.frame && anchor && anchor.gameTime >= live.tracker.startedAt - 0.001 &&
    anchor.gameTime < window.to && teamLive.since(anchor.gameTime, window.to);
  for (const [id, exact] of window.exact) {
    if (id === owner) continue;
    const prediction = estimated(id);
    const error = Math.abs(prediction - exact);
    bucket.errors.push(error);
    if (overlay && anchor.heroes.has(id)) {
      const missing = stat(window.frame, id) - stat(anchor, id);
      bucket.stale.push(Math.abs(missing));
      bucket.overlay.push(Math.abs((overlay.get(id)?.champion ?? 0) - missing));
    }
    if (bucket.worst && error <= bucket.worst.error) continue;
    const worst = { from: window.from, to: window.to, attacker: live.heroes.get(id) ?? id, estimated: prediction, exact, error };
    if (window.hits) {
      const targets = new Map();
      const row = target => {
        if (!targets.has(target)) targets.set(target, { target: live.heroes.get(target) ?? target, exact: 0, estimated: 0 });
        return targets.get(target);
      };
      for (const [, source, target, amount] of window.hits) if (source === id) row(target).exact += amount;
      for (const e of teamLive.events) {
        if (e.sourceId === id && e.time > window.from && e.time <= window.to) row(e.targetId).estimated += e.amount;
      }
      worst.targets = [...targets.values()];
    }
    bucket.worst = worst;
  }
}

function summarize(bucket) {
  const sorted = bucket.errors.sort((a, b) => a - b);
  return { active: bucket.active, leaders: bucket.leaders, playerWindows: sorted.length,
    meanError: mean(sorted), p95Error: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    scoreboardMeanError: mean(bucket.overlay), delayedMeanError: mean(bucket.stale),
    scoreboardPlayerWindows: bucket.overlay.length, worst: bucket.worst };
}

function localDead(sample) {
  const { activePlayer, allPlayers } = sample.data;
  return allPlayers?.find(p => (activePlayer?.riotId && p.riotId === activePlayer.riotId) ||
    (activePlayer?.summonerName && p.summonerName === activePlayer.summonerName))?.isDead;
}

export function auditRecording(dir) {
  const summary = JSON.parse(read(dir, 'summary.json'));
  const live = new DamageLive(path.join(dir, 'raw-ipv4.pcapng'), summary.fightGap);
  live.initialize(read(dir, 'original-r3dlog.txt').slice(0, 65536));
  if (!live.wire) throw new Error('Game log has no supported session');
  const timeline = [], samples = [], frames = [];
  for (const line of read(dir, 'observations.jsonl').split('\n')) {
    if (!line.startsWith('{"kind":"sample"') && !line.startsWith('{"kind":"team"')) continue;
    const entry = JSON.parse(line);
    entry.at = Date.parse(entry.at);
    if (entry.kind === 'sample') {
      entry.requestedAt = Date.parse(entry.requestedAt);
      samples.push(entry);
    } else {
      entry.heroes = new Map(entry.heroes);
      frames.push(entry);
    }
    timeline.push(entry);
  }
  if (!samples.length) throw new Error('No saved game clock or roster');
  const recapSamples = new Set();
  for (let i = 1; i < samples.length; i++) {
    if (localDead(samples[i]) && !localDead(samples[i - 1])) {
      for (let j = i - 1; j >= 0 && samples[i].at - samples[j].at <= 3000; j--) recapSamples.add(samples[j]);
    }
  }
  const checkpoints = scoringWindows(frames);
  let nearest = 0;
  for (const window of checkpoints) {
    while (nearest + 1 < samples.length && Math.abs(samples[nearest + 1].gameTime - window.to) <=
      Math.abs(samples[nearest].gameTime - window.to)) nearest++;
    const sample = samples[nearest], delta = window.to - sample.gameTime;
    if (Math.abs(delta) <= 2) timeline.push({ kind: 'check', window,
      at: (sample.requestedAt + sample.at) / 2 + 1000 * delta });
  }
  timeline.sort((a, b) => a.at - b.at);
  const bursts = scores(), intervals = scores(), fights = [], recaps = new Map();
  let anchor, cursor = 0;
  // Poll the production decoder with just the datagrams available at this instant.
  const capture = live.reader;
  let pending = [];
  live.reader = { read(consume) { for (const [packet, at] of pending) consume(packet, at); pending = []; } };
  function advance(event) {
    if (event.kind === 'sample') live.sample(event.data, event.requestedAt, event.at);
    live.poll();
    if (live.deathRecap?.duration != null) recaps.set(live.deathRecap.time, live.deathRecap);
    if (event.kind === 'team') {
      anchor = event;
      live.setTeamIds(new Map([...anchor.heroes].map(([id, hero]) => [id, hero.team])));
    } else if (event.kind === 'check' && live.tracker.gameId &&
        event.window.from >= live.tracker.startedAt - 0.001) {
      score(event.window.hits ? bursts : intervals, event.window, live, anchor);
    } else if (recapSamples.has(event) && localDead(event) === false) {
      const meter = live.meterSnapshot('champion').meter;
      const fight = meter?.fights.at(-1);
      if (fight && !meter.deathRecap) fights.push({ at: event.at, duration: fight.duration, damage: fight.total });
    }
  }
  do {
    const offset = capture.offset;
    capture.read((packet, at) => {
      while (cursor < timeline.length && timeline[cursor].at <= at) advance(timeline[cursor++]);
      pending.push([packet, at]);
    });
    if (capture.remaining && capture.offset === offset) throw new Error('Incomplete packet capture block');
    if (capture.remaining) live.poll();
  } while (capture.remaining);
  live.poll({ final: true });
  if (live.deathRecap?.duration != null) recaps.set(live.deathRecap.time, live.deathRecap);
  if (!live.wire.stats.checked) throw new Error('No verified game packets');
  const deaths = [];
  for (const recap of recaps.values()) {
    const previous = fights.findLast(f => f.at <= recap.time && recap.time - f.at <= 2000);
    if (!previous) continue;
    deaths.push({ gameTime: samples.findLast(s => s.at <= recap.time)?.gameTime,
      beforeDeathMs: recap.time - previous.at, estimate: previous.duration, exact: recap.duration,
      damageEstimate: previous.damage,
      damageExact: recap.schools ? Object.values(recap.schools).reduce((total, value) => total + value, 0) : null });
  }
  const coverage = { missingPackets: live.wire.stats.missing, lostFragments: live.wire.stats.fragmentLoss,
    decodeFailures: live.teamLiveLoss, droppedEstimates: live.teamLive.stats.dropped,
    clockLoss: live.clockLoss, captureLimit: !!summary.captureLimit, recordingError: !!summary.error };
  return { session: path.basename(dir), champion: summary.championName ?? live.heroes.get(live.owner),
    mode: samples[0].data.gameData.gameMode, protocol: live.protocol.build, fightGap: live.tracker.fightGap,
    start: live.tracker.startedAt, end: live.lastGameTime, coverage, gaps: Object.values(coverage).some(Boolean),
    frames: frames.length, hitChunks: frames.filter(f => Array.isArray(f.championHits) && !f.rejected).length,
    rejectedChunks: frames.filter(f => f.rejected > 0).length,
    fiveSeconds: summarize(bursts), thirtySeconds: summarize(intervals), recaps: recaps.size, deaths };
}

function run() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    latest: { type: 'string', default: '6' }, after: { type: 'string' }, json: { type: 'boolean' } } });
  const count = Number(values.latest);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('--latest requires a positive integer');
  const root = process.env.DAMAGE_RESEARCH_DIR || path.join(process.env.APPDATA, 'league-account-switcher', 'damage-research');
  const games = new DamageHistory(root).list();
  // Include reconnect segments for the selected matches and label each recording.
  const ids = positionals.length ? positionals : games.filter(g => !values.after || g.id > values.after)
    .slice(0, count).flatMap(g => g.recordings.map(s => s.id));
  const results = [];
  for (const id of ids) {
    const dir = path.resolve(root, id);
    try { results.push(auditRecording(dir)); }
    catch (error) { results.push({ session: path.basename(dir), skipped: error.message }); }
  }
  if (values.json) console.log(JSON.stringify(results, null, 2));
  else {
    if (!results.length) console.log('No matching completed recordings.');
    for (const game of results) {
      if (game.skipped) { console.log(game.session, 'skipped:', game.skipped); continue; }
      console.log('\n' + game.session, game.champion, game.mode, '(from ' + rounded(game.start) + 's; ' +
        game.hitChunks + ' hit chunks; ' + game.rejectedChunks + ' rejected' + (game.gaps ? '; partial capture' : '') + ')');
      for (const [label, s] of [['5s', game.fiveSeconds], ['30s', game.thirtySeconds]]) {
        console.log(' ', label, 'active windows:', s.active, 'correct team leader:', s.leaders + '/' + s.active,
          'mean miss:', rounded(s.meanError), '95th percentile:', rounded(s.p95Error));
        if (s.worst) console.log('    Worst:', s.worst.attacker, 'at', rounded(s.worst.to) + 's,',
          rounded(s.worst.estimated), 'estimated /', rounded(s.worst.exact), 'confirmed');
      }
      console.log('  Scoreboard mean miss:', rounded(game.thirtySeconds.scoreboardMeanError),
        '(delayed alone:', rounded(game.thirtySeconds.delayedMeanError) + ')');
      const within = game.deaths.filter(d => Math.abs(d.estimate - d.exact) <= 3).length;
      console.log('  Fight timer within 3s:', within + '/' + game.deaths.length, 'paired deaths;',
        game.recaps, 'decoded recaps');
    }
  }
  if (ids.length && results.every(g => g.skipped)) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) run();
