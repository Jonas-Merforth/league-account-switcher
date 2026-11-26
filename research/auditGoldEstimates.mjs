// Verifies keyframe GOLD_EARNED / GOLD_SPENT decoding and scores GoldTracker
// estimates against real .rofl replays and saved damage-research recordings.
//
// Usage:
//   node research/auditGoldEstimates.mjs [<path-to-rofl-or-recording> ...]
// Without arguments, scans League's Replays folder and damage-research folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeTeamKeyframe } from '../src/core/damageTeam.js';
import { GoldTracker } from '../src/core/goldTracker.js';
import { LcuClient } from '../src/core/lcu.js';
import { resolveLeaguePath } from '../src/core/config.js';
import { loadSettings } from '../src/core/settings.js';
import { DEFAULT_LEAGUE_PATH } from '../src/core/constants.js';
import { protocolForBuild, resolveProtocolForBuild } from '../src/core/liveProtocol.js';
import { readReplay } from './teamChunks16_22.mjs';

const REPLAY_DIR = process.env.LEAGUE_REPLAY_DIR || path.join(os.homedir(), 'Documents', 'League of Legends', 'Replays');
const RESEARCH_DIR = process.env.DAMAGE_RESEARCH_DIR || path.join(process.env.APPDATA || '', 'league-account-switcher', 'damage-research');

const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const whole = (n) => n == null ? 'n/a' : Math.round(n).toLocaleString('en-US');

export function inspectReplayGold(file) {
  const { build, metadata, segments } = readReplay(file);
  const resolved = resolveProtocolForBuild(build) ?? { protocol: protocolForBuild(build) };
  const protocol = resolved?.protocol;
  if (!protocol) return { file, error: `Unsupported build ${build}` };
  const keyframes = [];
  for (const segment of segments) {
    if (segment.type !== 2) continue;
    const frame = decodeTeamKeyframe(segment.data, protocol);
    if (frame.heroes.size) keyframes.push({ keyFrameId: segment.id, ...frame });
  }
  keyframes.sort((a, b) => a.gameTime - b.gameTime);
  const stats = JSON.parse(metadata.statsJson || '[]');
  const gameLength = Number(metadata.gameLength) / 1000;
  const last = keyframes.at(-1);
  if (!last || !stats.length) return { file, build, error: 'No keyframes or metadata stats' };

  const ids = [...last.heroes.keys()].sort((a, b) => a - b);
  const monotonic = keyframes.every((frame, i) => i === 0 || [...frame.heroes].every(([id, h]) => {
    const prev = keyframes[i - 1].heroes.get(id);
    return !prev || (h.goldEarned ?? 0) >= (prev.goldEarned ?? 0) - 0.5;
  }));
  const players = ids.map((id, index) => {
    const hero = last.heroes.get(id);
    const official = stats[index] || {};
    const finalEarned = Number(official.GOLD_EARNED);
    const finalSpent = Number(official.GOLD_SPENT);
    const kfEarned = hero.goldEarned ?? null;
    const kfSpent = hero.goldSpent ?? null;
    return {
      id,
      champion: official.SKIN || `#${index + 1}`,
      team: hero.team,
      position: official.INDIVIDUAL_POSITION || official.TEAM_POSITION || null,
      kfEarned,
      kfSpent,
      finalEarned: Number.isFinite(finalEarned) ? finalEarned : null,
      finalSpent: Number.isFinite(finalSpent) ? finalSpent : null,
      diffEarned: kfEarned != null && Number.isFinite(finalEarned) ? finalEarned - kfEarned : null
    };
  });
  return { file, build, gameLength, keyframeCount: keyframes.length, lastKeyframeTime: last.gameTime,
    gapToEnd: Number.isFinite(gameLength) ? gameLength - last.gameTime : null,
    monotonic, keyframes, stats, players };
}

function findGameId(dir) {
  const log = path.join(dir, 'original-r3dlog.txt');
  if (!fs.existsSync(log)) return null;
  const text = fs.readFileSync(log, 'utf8').slice(0, 65536);
  return /"-GameID=([1-9]\d+)"/.exec(text)?.[1] ?? /\bGameStartData::GameID=([1-9]\d+)\b/.exec(text)?.[1] ?? null;
}

export function auditPairedRecording(dir, replay) {
  const obsPath = path.join(dir, 'observations.jsonl');
  if (!fs.existsSync(obsPath)) return null;
  const samples = [];
  for (const line of fs.readFileSync(obsPath, 'utf8').split('\n')) {
    if (!line.startsWith('{"kind":"sample"')) continue;
    try { samples.push(JSON.parse(line)); } catch {}
  }
  if (!samples.length) return null;

  const keyframes = replay.keyframes;
  const tracker = new GoldTracker();
  const lastRoster = samples.at(-1).data.allPlayers || [];
  const activeId = samples.at(-1).data.activePlayer?.riotId || samples.at(-1).data.activePlayer?.summonerName;
  const mode = samples.at(-1).data.gameData?.gameMode || '?';
  const startGameTime = samples[0].data.gameData?.gameTime ?? 0;

  let kfIndex = 0;
  let sampleIndex = 0;
  const unanchoredPlayerErrors = [];
  const anchoredPlayerErrors = [];
  const delayedPlayerErrors = [];
  const unanchoredTeamErrors = [];
  const anchoredTeamErrors = [];
  const delayedTeamErrors = [];
  const windowDetails = [];

  for (let k = 0; k < keyframes.length; k++) {
    const targetKf = keyframes[k];
    if (targetKf.gameTime < startGameTime + 5) continue;
    while (sampleIndex < samples.length && (samples[sampleIndex].data.gameData?.gameTime ?? 0) <= targetKf.gameTime) {
      tracker.sample(samples[sampleIndex].data);
      sampleIndex++;
    }
    if (sampleIndex === 0) continue;
    const latestSample = samples[sampleIndex - 1].data;
    const roster = latestSample.allPlayers;
    const nowTime = latestSample.gameData.gameTime;
    if (Math.abs(nowTime - targetKf.gameTime) > 5) continue;

    // 1) Pure live estimate (no spectator anchor at all)
    const liveView = tracker.snapshot({ roster, playerId: activeId, gameTime: nowTime });
    // 2) Anchored at previous keyframe (simulating 60s spectator lag)
    const prevKf = k > 0 ? keyframes[k - 1] : null;
    const anchoredView = prevKf && prevKf.gameTime >= startGameTime
      ? tracker.snapshot({ anchor: prevKf, roster, playerId: activeId, gameTime: nowTime })
      : null;

    const truthByName = new Map();
    const ids = [...targetKf.heroes.keys()].sort((a, b) => a - b);
    const prevByName = new Map();
    for (let i = 0; i < ids.length; i++) {
      const truth = targetKf.heroes.get(ids[i]);
      const p = roster[i];
      if (!p || truth?.goldEarned == null) continue;
      truthByName.set(p.championName, { gold: truth.goldEarned, team: truth.team });
      if (prevKf) {
        const prevTruth = prevKf.heroes.get(ids[i]);
        if (prevTruth?.goldEarned != null) prevByName.set(p.championName, prevTruth.goldEarned);
      }
    }
    if (truthByName.size < 2) continue;

    const evalView = (view, playerErrs, teamErrs) => {
      if (!view) return;
      const byTeam = new Map();
      for (const group of view.teams) {
        for (const p of group.players) {
          const t = truthByName.get(p.name);
          if (!t) continue;
          playerErrs.push(Math.abs(p.gold - t.gold));
          const acc = byTeam.get(t.team) ?? { est: 0, truth: 0 };
          acc.est += p.gold;
          acc.truth += t.gold;
          byTeam.set(t.team, acc);
        }
      }
      if (byTeam.size === 2) {
        const [a, b] = [...byTeam.values()];
        const estDiff = a.est - b.est;
        const truthDiff = a.truth - b.truth;
        teamErrs.push(Math.abs(estDiff - truthDiff));
      }
    };

    evalView(liveView, unanchoredPlayerErrors, unanchoredTeamErrors);
    if (anchoredView) {
      evalView(anchoredView, anchoredPlayerErrors, anchoredTeamErrors);
      // Compare against stale un-estimated spectator keyframe (prevKf)
      const byTeam = new Map();
      for (const [name, t] of truthByName) {
        const prev = prevByName.get(name);
        if (prev == null) continue;
        delayedPlayerErrors.push(Math.abs(prev - t.gold));
        const acc = byTeam.get(t.team) ?? { prev: 0, truth: 0 };
        acc.prev += prev;
        acc.truth += t.gold;
        byTeam.set(t.team, acc);
      }
      if (byTeam.size === 2) {
        const [a, b] = [...byTeam.values()];
        delayedTeamErrors.push(Math.abs((a.prev - b.prev) - (a.truth - b.truth)));
      }
      windowDetails.push({ time: targetKf.gameTime, liveView, anchoredView, truthByName });
    }
    kfIndex++;
  }

  return {
    dir: path.basename(dir),
    mode,
    startGameTime,
    samples: samples.length,
    keyframesChecked: kfIndex,
    unanchored: { playerMean: mean(unanchoredPlayerErrors), playerMedian: median(unanchoredPlayerErrors), teamDiffMean: mean(unanchoredTeamErrors) },
    anchored60s: { playerMean: mean(anchoredPlayerErrors), playerMedian: median(anchoredPlayerErrors), teamDiffMean: mean(anchoredTeamErrors) },
    delayed60s: { playerMean: mean(delayedPlayerErrors), playerMedian: median(delayedPlayerErrors), teamDiffMean: mean(delayedTeamErrors) },
    lastWindow: windowDetails.at(-1) || null,
    windows: windowDetails
  };
}

function calibrateKiwi(dir, replay) {
  const samples = [];
  for (const line of fs.readFileSync(path.join(dir, 'observations.jsonl'), 'utf8').split('\n')) {
    if (line.startsWith('{"kind":"sample"')) { try { samples.push(JSON.parse(line)); } catch {} }
  }
  const kfs = replay.keyframes;
  const rows = [];
  let sIdx = 0;
  let prevSample = null;
  for (let k = 1; k < kfs.length; k++) {
    const prevKf = kfs[k - 1], kf = kfs[k];
    const deadSecs = new Map();
    while (sIdx < samples.length && (samples[sIdx].data.gameData?.gameTime ?? 0) <= kf.gameTime) {
      const cur = samples[sIdx].data;
      if (prevSample && cur.gameData.gameTime > prevKf.gameTime) {
        const dt = Math.max(0, cur.gameData.gameTime - Math.max(prevSample.gameData.gameTime, prevKf.gameTime));
        for (const p of cur.allPlayers || []) {
          if (p.isDead) deadSecs.set(p.championName, (deadSecs.get(p.championName) || 0) + dt);
        }
      }
      prevSample = cur;
      sIdx++;
    }
    if (!prevSample) continue;
    const prevS = samples.findLast((s) => (s.data.gameData?.gameTime ?? 0) <= prevKf.gameTime)?.data;
    const ids = [...kf.heroes.keys()].sort((a, b) => a - b);
    const quiet = [];
    for (let i = 0; i < ids.length; i++) {
      const pNow = prevSample.allPlayers[i];
      const pPrev = prevS?.allPlayers?.[i];
      if (!pNow || !pPrev) continue;
      const dGold = (kf.heroes.get(ids[i])?.goldEarned ?? 0) - (prevKf.heroes.get(ids[i])?.goldEarned ?? 0);
      const dKills = (pNow.scores?.kills || 0) - (pPrev.scores?.kills || 0);
      const dAssists = (pNow.scores?.assists || 0) - (pPrev.scores?.assists || 0);
      const dCs = (pNow.scores?.creepScore || 0) - (pPrev.scores?.creepScore || 0);
      const dead = deadSecs.get(pNow.championName) || 0;
      if (dKills === 0 && dAssists === 0 && dCs === 0) quiet.push({ name: pNow.championName, dGold: Math.round(dGold), dead: Math.round(dead) });
      rows.push({ t: Math.round(kf.gameTime), dGold, dKills, dAssists, dCs, dead });
    }
    if (quiet.length) {
      console.log(`    quiet t=${Math.round(prevKf.gameTime)}..${Math.round(kf.gameTime)}s: ${quiet.map((q) => `${q.name}=${q.dGold}(dead ${q.dead}s)`).join(', ')}`);
    }
  }
}

function effectiveLeaguePath() {
  if (process.env.LEAGUE_PATH) return process.env.LEAGUE_PATH;
  try {
    const settings = loadSettings();
    if (settings?.leaguePath && settings.leaguePath !== DEFAULT_LEAGUE_PATH) return settings.leaguePath;
  } catch {}
  return resolveLeaguePath();
}

async function auditClassicRecordings(dirs) {
  const leaguePath = effectiveLeaguePath();
  const lcu = new LcuClient({ leaguePath });
  const classicDirs = [];
  for (const dir of dirs) {
    const obs = path.join(dir, 'observations.jsonl');
    if (!fs.existsSync(obs)) continue;
    const text = fs.readFileSync(obs, 'utf8');
    if (!text.includes('"gameMode":"CLASSIC"')) continue;
    classicDirs.push(dir);
  }
  console.log(`\nFound ${classicDirs.length} Summoner's Rift (CLASSIC) recording(s); LCU path=${leaguePath}`);
  let lcuErrLogged = false;
  const allAnchored180 = [];
  const allDelayed180 = [];
  const allTeamDiffAnchored = [];
  const allTeamDiffDelayed = [];
  const roleSigned = new Map();

  for (const dir of classicDirs) {
    const gameId = findGameId(dir);
    const samples = [];
    for (const line of fs.readFileSync(path.join(dir, 'observations.jsonl'), 'utf8').split('\n')) {
      if (line.startsWith('{"kind":"sample"')) { try { samples.push(JSON.parse(line)); } catch {} }
    }
    if (!samples.length) continue;
    const startT = samples[0].data.gameData?.gameTime ?? 0;
    const endT = samples.at(-1).data.gameData?.gameTime ?? 0;
    if (endT - startT < 300) continue;

    let match = null, timeline = null;
    if (gameId) {
      try { match = await lcu.forCurrentSession().get(`/lol-match-history/v1/games/${gameId}`); }
      catch (err) { if (!lcuErrLogged) { console.log(`  [LCU match error for ${gameId}: ${err.message}]`); lcuErrLogged = true; } }
      if (match) {
        try { timeline = await lcu.forCurrentSession().get(`/lol-match-history/v1/game-timelines/${gameId}`); } catch {}
      }
    }

    // Build participant map (participantId -> { championName, role, team, goldEarned })
    const last = samples.at(-1).data;
    const activeId = last.activePlayer?.riotId || last.activePlayer?.summonerName;
    const roleByName = new Map();
    const pidByName = new Map();
    const finalByName = new Map();
    if (match) {
      const idByPid = new Map((match.participantIdentities || []).map((x) => [x.participantId, [
        x.player?.gameName, x.player?.riotIdGameName, x.player?.summonerName,
        x.player?.gameName && x.player?.tagLine ? `${x.player.gameName}#${x.player.tagLine}` : null
      ].filter(Boolean).map((s) => s.toLowerCase())]));
      for (const p of match.participants || []) {
        const ids = idByPid.get(p.participantId) || [];
        const r = (last.allPlayers || []).find((entry) => {
          const eIds = [entry.riotId, entry.summonerName, entry.riotId?.split('#')[0], entry.summonerName?.split('#')[0]]
            .filter(Boolean).map((s) => s.toLowerCase());
          return eIds.some((id) => ids.includes(id));
        });
        if (!r) continue;
        const slotRole = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'][(p.participantId - 1) % 5];
        const pos = p.teamPosition || p.individualPosition || slotRole;
        roleByName.set(r.championName, pos);
        pidByName.set(r.championName, p.participantId);
        finalByName.set(r.championName, {
          earned: p.stats?.goldEarned,
          spent: p.stats?.goldSpent,
          pos,
          team: p.teamId,
          laneCs: p.stats?.totalMinionsKilled || 0,
          jgCs: p.stats?.neutralMinionsKilled || 0
        });
      }
    }

    // Replay samples into GoldTracker, injecting known Match History role positions
    // (since older observations.jsonl didn't save allPlayers[].position).
    const tracker = new GoldTracker();
    const withPositions = (sampleData) => ({
      ...sampleData,
      allPlayers: (sampleData.allPlayers || []).map((p) => ({
        ...p,
        position: p.position || roleByName.get(p.championName) || ''
      }))
    });

    const frames = timeline?.frames || [];
    const gameAnchored180 = [];
    const gameDelayed180 = [];
    const gameTeamAnch = [];
    const gameTeamDel = [];
    let sIdx = 0;

    if (frames.length > 4) {
      for (let f = 0; f < frames.length; f++) {
        const tSec = frames[f].timestamp / 1000;
        if (tSec < startT + 10) continue;
        while (sIdx < samples.length && (samples[sIdx].data.gameData?.gameTime ?? 0) <= tSec) {
          tracker.sample(withPositions(samples[sIdx].data));
          sIdx++;
        }
        if (sIdx === 0) continue;
        const cur = withPositions(samples[sIdx - 1].data);
        if (Math.abs(cur.gameData.gameTime - tSec) > 5) continue;

        // Simulate 180s (3-minute) Summoner's Rift spectator delay using frame f-3
        const anchorFrame = f >= 3 ? frames[f - 3] : null;
        if (!anchorFrame || anchorFrame.timestamp / 1000 < startT) continue;
        const anchorSec = anchorFrame.timestamp / 1000;
        const heroMap = new Map();
        const base = 0x40000001;
        cur.allPlayers.forEach((p, idx) => {
          const pid = pidByName.get(p.championName);
          const pf = pid ? anchorFrame.participantFrames?.[String(pid)] : null;
          if (!pf) return;
          heroMap.set(base + idx, {
            team: p.team === 'ORDER' ? 100 : 200,
            kills: 0, deaths: 0, assists: 0,
            goldEarned: pf.totalGold,
            goldSpent: 0
          });
        });
        if (heroMap.size !== cur.allPlayers.length) continue;

        const view = tracker.snapshot({ anchor: { keyFrameId: f - 3, gameTime: anchorSec, heroes: heroMap },
          roster: cur.allPlayers, playerId: activeId, gameTime: tSec });
        const byTeam = new Map();
        const delTeam = new Map();
        for (const group of view.teams) {
          for (const p of group.players) {
            const pid = pidByName.get(p.name);
            const truth = frames[f].participantFrames?.[String(pid)]?.totalGold;
            const prev = anchorFrame.participantFrames?.[String(pid)]?.totalGold;
            if (truth == null || prev == null) continue;
            const signedErr = p.gold - truth;
            gameAnchored180.push(Math.abs(signedErr));
            gameDelayed180.push(Math.abs(prev - truth));
            allAnchored180.push(Math.abs(signedErr));
            allDelayed180.push(Math.abs(prev - truth));
            const rKey = p.position || 'UNKNOWN';
            if (!roleSigned.has(rKey)) roleSigned.set(rKey, []);
            roleSigned.get(rKey).push(signedErr);

            const tAcc = byTeam.get(p.team) ?? { est: 0, truth: 0 };
            tAcc.est += p.gold; tAcc.truth += truth; byTeam.set(p.team, tAcc);
            const dAcc = delTeam.get(p.team) ?? { prev: 0, truth: 0 };
            dAcc.prev += prev; dAcc.truth += truth; delTeam.set(p.team, dAcc);
          }
        }
        if (byTeam.size === 2) {
          const [a, b] = [...byTeam.values()];
          const eDiff = Math.abs((a.est - b.est) - (a.truth - b.truth));
          gameTeamAnch.push(eDiff); allTeamDiffAnchored.push(eDiff);
          const [da, db] = [...delTeam.values()];
          const dDiff = Math.abs((da.prev - db.prev) - (da.truth - db.truth));
          gameTeamDel.push(dDiff); allTeamDiffDelayed.push(dDiff);
        }
      }
    }
    // Finish remaining samples
    while (sIdx < samples.length) { tracker.sample(withPositions(samples[sIdx].data)); sIdx++; }
    const estView = tracker.snapshot({ roster: withPositions(last).allPlayers, playerId: activeId, gameTime: endT });

    console.log(`\n## SR ${path.basename(dir)} (game ${gameId || '?'}, t=${Math.round(startT)}..${Math.round(endT)}s, match=${!!match}, timelineFrames=${frames.length})`);
    if (gameAnchored180.length) {
      console.log(`  180s delayed spectator only:       player mean err ${whole(mean(gameDelayed180))}g (med ${whole(median(gameDelayed180))}g) | team diff err ${whole(mean(gameTeamDel))}g`);
      console.log(`  Spectator + live GoldTracker 180s: player mean err ${whole(mean(gameAnchored180))}g (med ${whole(median(gameAnchored180))}g) | team diff err ${whole(mean(gameTeamAnch))}g`);
    }
    if (match) {
      const errs = [];
      for (const group of estView.teams) {
        for (const p of group.players) {
          const m = finalByName.get(p.name);
          const err = m ? p.gold - m.earned : null;
          if (err != null) errs.push(Math.abs(err));
          const trueCs = m ? m.laneCs + m.jgCs : null;
          console.log(`    ${p.name.padEnd(14)} ${group.side.padEnd(5)} pos=${String(m?.pos || p.position || '-').padEnd(7)} liveCS=${String(p.cs).padStart(3)} trueCS=${String(trueCs ?? '-').padStart(3)} (jg=${String(m?.jgCs ?? '-').padStart(3)}) ${p.kills}/${p.deaths}/${p.assists}  est=${whole(p.gold).padStart(7)} match=${whole(m?.earned).padStart(7)} err=${err == null ? 'n/a' : (err >= 0 ? '+' : '') + whole(err)}`);
        }
      }
      if (errs.length) console.log(`  Unanchored full-game mean error: ${whole(mean(errs))}g (median ${whole(median(errs))}g)`);
    }
  }
  if (allAnchored180.length) {
    console.log(`\n=== SUMMONER'S RIFT OVERALL (${allAnchored180.length} player-minutes at 180s spectator delay) ===`);
    console.log(`  180s delayed spectator only:       player mean err ${whole(mean(allDelayed180))}g (med ${whole(median(allDelayed180))}g) | team diff err ${whole(mean(allTeamDiffDelayed))}g`);
    console.log(`  Spectator + live GoldTracker 180s: player mean err ${whole(mean(allAnchored180))}g (med ${whole(median(allAnchored180))}g) | team diff err ${whole(mean(allTeamDiffAnchored))}g`);
    for (const [role, errs] of roleSigned) {
      const abs = errs.map(Math.abs);
      console.log(`    role ${role.padEnd(8)} meanSigned=${(mean(errs) >= 0 ? '+' : '') + whole(mean(errs)).padStart(5)}g  meanAbs=${whole(mean(abs)).padStart(4)}g  medAbs=${whole(median(abs)).padStart(4)}g  (n=${errs.length})`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const pathArgs = args.filter((a) => !a.startsWith('--'));
  const roflFiles = [];
  if (pathArgs.length) {
    for (const arg of pathArgs) if (arg.endsWith('.rofl') && fs.existsSync(arg)) roflFiles.push(arg);
  } else if (fs.existsSync(REPLAY_DIR)) {
    for (const name of fs.readdirSync(REPLAY_DIR).sort()) {
      if (name.endsWith('.rofl')) roflFiles.push(path.join(REPLAY_DIR, name));
    }
  }

  const replaysByGameId = new Map();
  console.log(`Found ${roflFiles.length} replay(s) in ${REPLAY_DIR}`);
  for (const file of roflFiles) {
    let result;
    try { result = inspectReplayGold(file); }
    catch (error) { console.log(`  [skip] ${path.basename(file)}: ${error.message}`); continue; }
    if (result.error) { console.log(`  [skip] ${path.basename(file)}: ${result.error}`); continue; }
    const gameId = /(\d{7,})/.exec(path.basename(file))?.[1];
    if (gameId) replaysByGameId.set(gameId, result);
    const validGold = result.players.filter((p) => p.kfEarned != null).length;
    const validSpent = result.players.filter((p) => p.kfSpent != null).length;
    const allAtOrBelowFinal = result.players.every((p) => p.diffEarned != null && p.diffEarned >= -1);
    console.log(`\n## Replay ${path.basename(file)} (${result.build}) — ${result.keyframeCount} keyframes, last at ${result.lastKeyframeTime.toFixed(1)}s (game end ${result.gameLength.toFixed(1)}s, gap ${result.gapToEnd.toFixed(1)}s)`);
    console.log(`  GOLD_EARNED decoded: ${validGold}/${result.players.length} | GOLD_SPENT decoded: ${validSpent}/${result.players.length} | monotonic: ${result.monotonic} | <= final: ${allAtOrBelowFinal}`);
    if (args.includes('--keyframes')) {
      for (let i = 0; i < result.keyframes.length; i++) {
        const kf = result.keyframes[i];
        const golds = [...kf.heroes.values()].map((h) => Math.round(h.goldEarned ?? 0));
        const prev = i > 0 ? [...result.keyframes[i - 1].heroes.values()].map((h) => Math.round(h.goldEarned ?? 0)) : null;
        const deltas = prev ? golds.map((g, j) => g - prev[j]) : null;
        console.log(`    kf ${String(kf.keyFrameId).padStart(2)} t=${kf.gameTime.toFixed(1).padStart(6)} ${deltas ? `d=[${deltas.join(',')}]` : `g=[${golds.join(',')}]`}`);
      }
    }
    for (const p of result.players) {
      console.log(`    ${String(p.champion).padEnd(14)} pos=${String(p.position || '-').padEnd(7)} kfEarned=${whole(p.kfEarned).padStart(7)} finalEarned=${whole(p.finalEarned).padStart(7)} (gap ${whole(p.diffEarned).padStart(5)})  kfSpent=${whole(p.kfSpent).padStart(7)} finalSpent=${whole(p.finalSpent).padStart(7)}`);
    }
  }

  if (fs.existsSync(RESEARCH_DIR)) {
    const dirs = fs.readdirSync(RESEARCH_DIR).sort().map((n) => path.join(RESEARCH_DIR, n)).filter((d) => fs.statSync(d).isDirectory());
    if (args.includes('--list')) {
      console.log(`\nRecordings in ${RESEARCH_DIR} (${dirs.length}):`);
      for (const dir of dirs) {
        const obs = path.join(dir, 'observations.jsonl');
        if (!fs.existsSync(obs)) continue;
        let mode = '?', t0 = null, t1 = null, teams = 0;
        for (const line of fs.readFileSync(obs, 'utf8').split('\n')) {
          if (line.startsWith('{"kind":"sample"')) {
            const e = JSON.parse(line);
            if (t0 === null) t0 = e.gameTime;
            t1 = e.gameTime;
            mode = e.data?.gameData?.gameMode || mode;
          } else if (line.startsWith('{"kind":"team"')) teams++;
        }
        const gameId = findGameId(dir);
        console.log(`  ${path.basename(dir)}  game=${String(gameId || '-').padEnd(11)} mode=${mode.padEnd(10)} t=${Math.round(t0 || 0)}..${Math.round(t1 || 0)}s  teamFrames=${teams}  hasReplay=${replaysByGameId.has(gameId)}`);
      }
    }
    let pairedCount = 0;
    for (const dir of dirs) {
      const gameId = findGameId(dir);
      const replay = gameId ? replaysByGameId.get(gameId) : null;
      if (!replay) continue;
      const audit = auditPairedRecording(dir, replay);
      if (!audit || !audit.keyframesChecked) continue;
      pairedCount++;
      console.log(`\n## Paired Recording ${audit.dir} (game ${gameId}, ${audit.mode}, start ${Math.round(audit.startGameTime)}s, ${audit.keyframesChecked} keyframes)`);
      console.log(`  60s delayed spectator (no live est): player mean err ${whole(audit.delayed60s.playerMean)}g (median ${whole(audit.delayed60s.playerMedian)}g) | team diff err ${whole(audit.delayed60s.teamDiffMean)}g`);
      console.log(`  Spectator + live GoldTracker (60s):  player mean err ${whole(audit.anchored60s.playerMean)}g (median ${whole(audit.anchored60s.playerMedian)}g) | team diff err ${whole(audit.anchored60s.teamDiffMean)}g`);
      console.log(`  Pure live GoldTracker (no anchor):   player mean err ${whole(audit.unanchored.playerMean)}g (median ${whole(audit.unanchored.playerMedian)}g) | team diff err ${whole(audit.unanchored.teamDiffMean)}g`);
      if (audit.lastWindow) {
        console.log(`  Sample at ${Math.round(audit.lastWindow.time)}s (anchored 60s vs truth):`);
        for (const group of audit.lastWindow.anchoredView.teams) {
          for (const p of group.players) {
            const t = audit.lastWindow.truthByName.get(p.name);
            if (!t) continue;
            const err = p.gold - Math.round(t.gold);
            console.log(`    ${p.name.padEnd(14)} est=${whole(p.gold).padStart(7)} truth=${whole(t.gold).padStart(7)} err=${(err >= 0 ? '+' : '') + whole(err)}`);
          }
        }
      }
      if (args.includes('--calibrate')) {
        console.log('  Quiet zero-K/A/CS player-minutes:');
        calibrateKiwi(dir, replay);
      }
      if (args.includes('--windows')) {
        for (const w of audit.windows) {
          const errs = [];
          for (const group of w.anchoredView.teams) {
            for (const p of group.players) {
              const t = w.truthByName.get(p.name);
              if (t) errs.push(Math.round(p.gold - t.gold));
            }
          }
          console.log(`    t=${Math.round(w.time).toString().padStart(4)}s meanSigned=${Math.round(mean(errs)).toString().padStart(5)} errs=[${errs.join(',')}]`);
        }
      }
    }
    if (!pairedCount) console.log(`\nNo paired recording+replay matches found between ${RESEARCH_DIR} and ${REPLAY_DIR}.`);
    if (args.includes('--classic')) await auditClassicRecordings(dirs);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) void main();
