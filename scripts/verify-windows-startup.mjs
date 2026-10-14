// Exercise real Windows login-item registration and launch its exact arguments
// from an unrelated working directory. Uses an isolated store and a temporary
// Run entry; never changes the user's normal startup preference or accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'win32') throw new Error('This check requires Windows.');
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = require('electron');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'switcher startup '));
const env = { ...process.env, LCA_CONFIG_DIR: path.join(temp, 'config'), LAS_SELFTEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;

function run(exe, args, windowsVerbatimArguments = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: temp, env, windowsHide: true, windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Startup verification timed out: ${output}`)); }, 35_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Startup verification exited ${code}: ${output}`));
      else resolve(output);
    });
  });
}

try {
  // Use a space-containing path for the development entry, even on checkouts
  // whose actual path has no spaces. A junction preserves module resolution.
  const checkout = path.join(temp, 'development checkout');
  await fs.symlink(root, checkout, 'junction');
  const variants = [
    { label: 'development', isPackaged: false, execPath: electron, appPath: checkout },
    { label: 'packaged', isPackaged: true, execPath: path.join(root, 'dist', 'win-unpacked', 'League Account Switcher.exe'), appPath: '' }
  ];
  const bootstrap = path.join(temp, 'registration.cjs');
  const helper = pathToFileURL(path.join(root, 'src', 'core', 'loginItem.js')).href;
  for (const variant of variants) {
    await fs.access(variant.execPath);
    const name = `com.merforth.league-account-switcher.test-${process.pid}`;
    await fs.writeFile(bootstrap, `
      const { app } = require('electron');
      app.setAppUserModelId(${JSON.stringify(name)});
      app.whenReady().then(async () => {
        const { loginItemSettings } = await import(${JSON.stringify(helper)});
        const options = loginItemSettings(${JSON.stringify({ ...variant, enabled: true, name })});
        try {
          app.setLoginItemSettings(options);
          const state = app.getLoginItemSettings({ path: options.path, args: options.args });
          if (!state.openAtLogin) throw new Error('Windows did not retain the exact startup command');
          console.log('STARTUP_COMMAND=' + JSON.stringify(options));
        } catch (error) { console.error(error.message); process.exitCode = 1; }
        finally { app.setLoginItemSettings({ ...options, openAtLogin: false }); app.exit(process.exitCode || 0); }
      });
    `);
    const registered = await run(electron, [bootstrap]);
    const options = JSON.parse(registered.match(/STARTUP_COMMAND=(.+)/)?.[1] || 'null');
    assert.ok(options, registered);
    // Preserve the argument quoting exactly as Electron wrote it, so a missing
    // quote cannot be accidentally repaired by Node's default argument escaping.
    const output = await run(variant.execPath, options.args, true);
    assert.match(output, /SELFTEST: booted; window=ok; tray=ok/);
    assert.match(output, /preload-api=true/);
    assert.match(output, /SELFTEST: done/);
    assert.doesNotMatch(output, /probe-error|preload-error|did-fail-load|TIMEOUT/);
    console.log(`${variant.label}: Windows registered the exact command; switcher window, tray, renderer and IPC loaded from an unrelated directory.`);
  }
} finally {
  // Remove only the junction itself before cleaning the temporary directory.
  await fs.unlink(path.join(temp, 'development checkout')).catch(() => {});
  await fs.rm(temp, { recursive: true, force: true });
}
