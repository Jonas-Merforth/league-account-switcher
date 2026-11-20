import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { protocolForBuild } from '../core/liveProtocol.js';

const execute = promisify(execFile);
const inMatch = new Set(['GameStart', 'InProgress', 'Reconnect']);

export async function installedGameBuild(leaguePath) {
  const executable = join(leaguePath(), 'Game', 'League of Legends.exe');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-Item -LiteralPath $env:LAS_EVIDENCE_GAME_EXE -ErrorAction Stop).VersionInfo.FileVersion'],
  { windowsHide: true, timeout: 8000, env: { ...process.env, LAS_EVIDENCE_GAME_EXE: executable } });
  const build = stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(build)) throw new Error('No exact installed game build');
  return build;
}

export async function requestEvidenceReplay(client, gameId, wait = ms => new Promise(resolve => {
  setTimeout(resolve, ms).unref();
})) {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.request('POST', `/lol-replays/v1/rofls/${gameId}/download`,
        { componentType: 'replay-button' }, { allowMissing: false });
      return;
    } catch (error) {
      if (error.code === 'LCU_SESSION_CHANGED' || attempt >= 5) throw error;
      await wait(15_000);
    }
  }
}

// Used only on an explicitly designated evidence PC. One attempt per game
// respects a declined Windows recording prompt or a manual stop.
export function evidenceCollector({ recorder, version, known = protocolForBuild, enabled, log }) {
  let attempted = false, started = null, entered = false;
  return async function observe(phase) {
    if (phase !== 'ChampSelect' && !inMatch.has(phase)) {
      if (started && started === recorder.sessionDirectory && !entered && recorder.capture.busy) recorder.stop();
      attempted = false;
      started = null;
      entered = false;
      return;
    }
    if (inMatch.has(phase)) entered = true;
    if (attempted || !enabled()) return;
    attempted = true;
    try {
      if (recorder.capture.busy || recorder.pending || known(await version()) || !enabled()) return;
      recorder.start();
      started = recorder.sessionDirectory;
    } catch (error) { log('Evidence recording: ' + error.message, 'warn'); }
  };
}
