import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runPowerShell } from '../src/core/powershell.js';
import { RIOT_LOGIN_MSAA_SCRIPT } from '../src/core/riotLoginMsaa.js';

const enabled = process.platform === 'win32' && process.env.LAS_LOGIN_NATIVE_TEST === '1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitJson(file) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
    await delay(100);
  }
  throw new Error(`Fixture did not produce ${path.basename(file)}`);
}

test('native login enables a cold Chromium web tree and submits verified fields', { skip: !enabled, timeout: 40000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'las-login-test-'));
  const electron = createRequire(import.meta.url)('electron');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL('../scripts/test-fixtures/riot-login.cjs', import.meta.url)), directory], {
    env: environment, stdio: 'ignore', windowsHide: true
  });
  const closed = new Promise(resolve => child.once('exit', resolve));
  try {
    const ready = await waitJson(path.join(directory, 'ready.json'));
    assert.equal(ready.accessibilityEnabled, false);
    // Scope the real production script to this fixture's exact process, never any Riot account.
    const script = RIOT_LOGIN_MSAA_SCRIPT.replace(
      "Get-Process -Name 'Riot Client','RiotClientUx'", `Get-Process -Id ${child.pid}`
    );
    const output = await runPowerShell(script, {
      input: JSON.stringify({ username: 'fixture-user', password: 'fixture-password', riotRoot: path.dirname(electron) + path.sep }),
      timeoutMs: 25000
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.submitted, true, JSON.stringify(result));
    assert.equal(result.persistenceVerified, true);
    assert.deepEqual(await waitJson(path.join(directory, 'result.json')), {
      usernameMatched: true, passwordMatched: true, remembered: true
    });
  } finally {
    child.kill();
    await closed;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('las-login-test-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
