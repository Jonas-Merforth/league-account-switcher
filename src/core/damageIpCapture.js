import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const header = Buffer.from('0a0d0d0a1c0000004d3c2b1a01000000ffffffffffffffff1c0000000100000014000000e4000000ffff000014000000', 'hex');
const STATUS_POLL_MS = 250;
const STATUS_TIMEOUT_MS = 120_000;
export const DAMAGE_SESSION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}$/;

// The helper writes a fixed little-endian IPv4 PCAPNG profile. Read only new
// complete blocks so a simultaneous helper flush cannot become a partial hit.
export class DamageIpReader {
  constructor(file) { this.file = file; this.offset = 0; }
  read(onDatagram) {
    let descriptor;
    try { descriptor = fs.openSync(this.file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try {
      const size = fs.fstatSync(descriptor).size;
      if (size < this.offset) throw new Error('Capture file unexpectedly shrank.');
      if (size < header.length) return;
      if (!this.offset) {
        const actual = Buffer.alloc(header.length);
        fs.readSync(descriptor, actual, 0, actual.length, 0);
        if (!actual.equals(header)) throw new Error('Unsupported IP capture file.');
        this.offset = header.length;
      }
      // Limit one polling pass so startup bursts do not stall the renderer.
      const data = Buffer.alloc(Math.min(size - this.offset, 2 * 1024 * 1024));
      const length = fs.readSync(descriptor, data, 0, data.length, this.offset);
      let pos = 0;
      while (pos + 8 <= length) {
        const block = data.readUInt32LE(pos + 4);
        if (data.readUInt32LE(pos) !== 6 || block < 32 || block > 65600 || block % 4) throw new Error('Invalid IP capture block.');
        if (pos + block > length) break;
        const bytes = data.readUInt32LE(pos + 20);
        if (data.readUInt32LE(pos + block - 4) !== block || bytes < 28 || bytes !== data.readUInt32LE(pos + 24) ||
            32 + ((bytes + 3) & ~3) !== block) throw new Error('Invalid IP capture packet size.');
        const time = (data.readUInt32LE(pos + 12) * 4294967296 + data.readUInt32LE(pos + 16)) / 1000;
        onDatagram(data.subarray(pos + 28, pos + 28 + bytes), time);
        pos += block;
      }
      this.offset += pos;
      this.remaining = size - this.offset;
    } finally { fs.closeSync(descriptor); }
  }
}

export class DamageIpCapture {
  constructor({ onUpdate, onHelperExit, leaguePath }) {
    this.onUpdate = onUpdate;
    this.onHelperExit = onHelperExit;
    this.leaguePath = leaguePath;
  }
  get controlDirectory() { return this.helper?.directory; }
  update(state) { this.state = state; this.onUpdate(state); }
  start(file, { continuous = false } = {}) {
    if (this.busy || this.helper?.stopping) throw new Error('Wait for the previous recorder to finish.');
    if (process.platform !== 'win32') throw new Error('The Damage recorder requires Windows.');
    const directory = path.dirname(file);
    const league = path.resolve(this.leaguePath());
    if (!fs.existsSync(path.join(league, 'Game', 'League of Legends.exe'))) throw new Error('The League game installation could not be found.');
    if (continuous && this.helper?.continuous) {
      fs.writeFileSync(path.join(directory, 'heartbeat'), 'alive');
      const request = path.join(this.helper.directory, 'next-session');
      fs.writeFileSync(request + '.tmp', path.basename(directory));
      fs.renameSync(request + '.tmp', request);
      this.begin(directory, { state: 'waiting', detail: 'Recorder ready for the next League match' });
      return;
    }
    const script = path.join(directory, 'damageCapture.ps1');
    fs.copyFileSync(fileURLToPath(new URL('./damageCapture.ps1', import.meta.url)), script);
    fs.copyFileSync(fileURLToPath(new URL('./DamageIpCapture.cs', import.meta.url)), path.join(directory, 'DamageIpCapture.cs'));
    fs.writeFileSync(path.join(directory, 'heartbeat'), 'alive');
    const helper = { directory, continuous };
    this.helper = helper;
    this.begin(directory, { state: 'starting', detail: 'Waiting for Windows administrator permission' });
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const argumentsForHelper = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" -SessionDir "${directory}" -LeaguePath "${league}"` +
      (continuous ? ' -Continuous' : '');
    const command = `$ErrorActionPreference='Stop'; $helper = Start-Process -FilePath ${quote(powershell)} -Verb RunAs -WindowStyle Hidden -ArgumentList ${quote(argumentsForHelper)} -Wait -PassThru; exit $helper.ExitCode`;
    const launcher = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' });
    const finish = () => {
      if (helper.exited) return;
      helper.exited = true;
      this.handleHelperExit(helper);
      this.onHelperExit?.();
    };
    launcher.once('error', finish);
    launcher.once('exit', finish);
  }
  handleHelperExit(helper) {
    if (this.helper !== helper) return;
    this.helper = null;
    if (!this.busy) return;
    this.poll();
    if (!this.busy) return;
    if (this.state.state === 'stopping') {
      this.finish({ ...this.state, state: 'complete', detail: this.state.gameStartedAt
        ? 'IP-layer capture finished' : 'Recorder stopped before a game was found' });
      return;
    }
    this.finish({ state: 'error', detail: (helper.responded || this.helperResponded)
      ? 'The administrator recorder stopped unexpectedly.' : 'Windows did not start the administrator recorder.',
      gameStartedAt: this.state.gameStartedAt });
  }
  begin(directory, state) {
    this.directory = directory;
    this.busy = true;
    this.helperResponded = false;
    this.statusPolls = 0;
    this.update(state);
    this.timer = setInterval(() => this.poll(), STATUS_POLL_MS);
    this.timer.unref?.();
  }
  finish(state) { clearInterval(this.timer); this.busy = false; this.update(state); }
  poll() {
    try {
      fs.writeFileSync(path.join(this.directory, 'heartbeat'), 'alive');
      if (this.helper?.continuous && this.helper.directory !== this.directory) {
        fs.writeFileSync(path.join(this.helper.directory, 'heartbeat'), 'alive');
      }
      const state = JSON.parse(fs.readFileSync(path.join(this.directory, 'status.json'), 'utf8'));
      this.helperResponded = true;
      if (this.helper) this.helper.responded = true;
      if (state.state === 'complete' || state.state === 'error') {
        if (state.state === 'error') this.stopHelper();
        this.finish(state);
      }
      else if (this.state.state !== 'stopping') this.update(state);
    } catch (error) {
      if (!['ENOENT', 'EPERM', 'EBUSY'].includes(error.code) && !(error instanceof SyntaxError)) {
        this.stopHelper();
        this.finish({ ...this.state, state: 'error', detail: 'Cannot read the recorder status.' });
      }
    }
    // Polls pause during sleep, including while an administrator prompt is open.
    if (this.busy && !this.helperResponded && ++this.statusPolls * STATUS_POLL_MS >= STATUS_TIMEOUT_MS) {
      this.stop();
      this.finish({ state: 'error', detail: 'The administrator recorder did not respond.' });
    }
  }
  stopHelper() {
    if (!this.helper?.continuous || this.helper.stopping) return;
    fs.writeFileSync(path.join(this.helper.directory, 'stop-helper'), 'stop');
    this.helper.stopping = true;
  }
  stop() {
    this.stopHelper();
    if (!this.busy || this.state.state === 'stopping') return;
    fs.writeFileSync(path.join(this.directory, 'stop'), 'stop');
    this.update({ ...this.state, state: 'stopping', detail: 'Stopping IP-layer capture' });
  }
}
