import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { indexPcap } from './ffPcap.js';

const quotePS = (value) => `'${String(value).replaceAll("'", "''")}'`;
const finished = (state) => ['complete', 'error'].includes(state);

export class FFPacketCapture {
  constructor({ onUpdate = () => {}, smokeTest = false } = {}) { this.onUpdate = onUpdate; this.smokeTest = smokeTest; this.state = { state: 'off', detail: 'Packet capture is off' }; }
  start(captureFile) {
    if (this.busy) throw new Error('Previous packet capture is still stopping/converting. Wait before starting another.');
    if (process.platform !== 'win32') throw new Error('Packet capture requires Windows.');
    this.directory = captureFile.replace(/\.jsonl$/i, '.packets');
    fs.mkdirSync(this.directory, { recursive: false });
    // Copy from app.asar too: PowerShell needs an ordinary filesystem script.
    const script = path.join(this.directory, 'capture-helper.ps1');
    fs.copyFileSync(fileURLToPath(new URL('./ffPacketCapture.ps1', import.meta.url)), script);
    this.busy = true; this.indexed = false; this.launchedAt = Date.now();
    this.update({ state: 'starting', detail: 'Waiting for Windows administrator permission', directory: this.directory });
    fs.writeFileSync(path.join(this.directory, 'heartbeat'), 'alive');
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Only fixed helper code and quoted paths cross the elevation boundary.
    const args = `-NoProfile -ExecutionPolicy Bypass -File "${script}" -SessionDir "${this.directory}"${this.smokeTest ? ' -SmokeTest' : ''}`;
    const command = `$ErrorActionPreference='Stop'; try { Start-Process -FilePath ${quotePS(executable)} -Verb RunAs -WindowStyle Hidden -ArgumentList ${quotePS(args)} } catch { exit 1 }`;
    const launcher = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' });
    const fail = () => { if (this.state.state === 'starting') this.finish({ state: 'error', detail: 'Administrator helper could not start (permission declined or launch failed).' }); };
    launcher.once('error', fail); launcher.once('exit', (code) => { if (code !== 0) fail(); });
    this.timer = setInterval(() => this.poll(), 1000); this.timer.unref?.();
  }
  update(state) { this.state = { ...state, directory: this.directory }; this.onUpdate(this.state); }
  finish(state) {
    clearInterval(this.timer); this.busy = false;
    try { fs.writeFileSync(path.join(this.directory, 'capture-result.json'), JSON.stringify(state, null, 2)); } catch { /* UI still exposes the failure. */ }
    this.update(state);
  }
  poll() {
    if (this.state.state === 'starting' && Date.now() - this.launchedAt > 120000) {
      this.stop();
      this.finish({ state: 'error', detail: 'Administrator helper did not report ready within two minutes. Stop requested.' });
      return;
    }
    try {
      fs.writeFileSync(path.join(this.directory, 'heartbeat'), 'alive');
      const state = JSON.parse(fs.readFileSync(path.join(this.directory, 'status.json'), 'utf8'));
      if (finished(state.state) && state.pcapBytes && !this.indexed) {
        this.indexed = true;
        try {
          state.validation = indexPcap(path.join(this.directory, 'packets.pcapng'), path.join(this.directory, 'packet-index.jsonl'), state.ports);
          const priorError = state.state === 'error' ? `${state.detail} ` : '';
          state.detail = `${priorError}${state.validation.packets} packet records saved (${state.validation.udpPackets} UDP); no vote decoder`;
          if (!state.validation.packets) { state.state = 'error'; state.detail = 'PCAPNG contains no packets. Capture is not verified.'; }
          fs.writeFileSync(path.join(this.directory, 'validation.json'), JSON.stringify(state.validation, null, 2));
        } catch (error) { state.state = 'error'; state.detail = `Packet validation failed: ${error.message}`; }
      }
      if (finished(state.state)) this.finish(state);
      else if (state.state !== this.state.state || state.detail !== this.state.detail) this.update(state);
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code) && !(error instanceof SyntaxError)) this.finish({ state: 'error', detail: 'Cannot read packet helper status.' });
    }
  }
  stop() {
    if (this.busy) {
      fs.writeFileSync(path.join(this.directory, 'stop'), 'stop');
      this.update({ ...this.state, state: 'stopping', detail: 'Waiting for packet conversion and validation' });
    }
  }
  export(destination) {
    if (this.busy) throw new Error('Stop recording and wait for packet conversion before exporting.');
    if (!this.directory) return null;
    const target = destination.replace(/\.jsonl$/i, '') + '.packets';
    // Exclusive creation prevents mixing two sessions or overwriting source files.
    fs.mkdirSync(target);
    // Segment ETLs (packets-2.etl, ...) exist when the game opened new sockets mid-capture.
    const names = fs.readdirSync(this.directory).filter((name) => /^packets(-\d+)?\.etl$/.test(name));
    for (const name of [...names, 'packets.pcapng', 'packet-index.jsonl', 'status.json', 'validation.json', 'capture-result.json']) {
      const source = path.join(this.directory, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, name), fs.constants.COPYFILE_EXCL);
    }
    return target;
  }
}
