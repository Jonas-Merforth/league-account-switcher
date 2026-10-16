import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runPowerShell } from '../src/core/powershell.js';
import { LEAGUE_TOAST_SCRIPT } from '../src/core/leagueToastCleanup.js';

const enabled = process.platform === 'win32' && process.env.LAS_TOAST_NATIVE_TEST === '1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ['positive', 'wrong-parent', 'hidden', 'duplicate', 'phase-blocked', 'session-changed']) {
  test(`native celebration cleanup: ${mode}`, { skip: !enabled, timeout: 25000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'las-toast-test-'));
    const electron = createRequire(import.meta.url)('electron');
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [fileURLToPath(new URL('../scripts/test-fixtures/league-toast.cjs', import.meta.url)), directory, `--case=${mode}`], {
      env: environment, stdio: 'ignore', windowsHide: true
    });
    const closed = new Promise(resolve => child.once('exit', resolve));
    try {
      const statePath = path.join(directory, 'state.json');
      let state;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const ready = JSON.parse(await fs.readFile(path.join(directory, 'ready.json'), 'utf8'));
          assert.equal(ready.accessibilityEnabled, false);
          state = JSON.parse(await fs.readFile(statePath, 'utf8'));
          break;
        } catch {}
        await delay(100);
      }
      assert.ok(state, 'fixture started');
      const lockfile = path.join(directory, 'lockfile');
      await fs.writeFile(lockfile, `fixture:${process.pid}:1234:${mode === 'session-changed' ? 'changed' : 'fixture'}:https`);
      // Exact fixture PID; never inspect or invoke the user's live League window in this test.
      // Keep real window selection, COM traversal, lockfile validation and invocation; substitute
      // only the LCU gameflow response for this isolated Electron fixture.
      const script = LEAGUE_TOAST_SCRIPT
        .replace("Get-Process -Name 'LeagueClientUx'", `Get-Process -Id ${child.pid}`)
        .replace('[LeagueToast]::Phase($request.port,$request.password) | ConvertFrom-Json', '$request.fixturePhase');
      const input = JSON.stringify({ executable: electron, clientPid: process.pid, port: 1234,
        password: 'fixture', lockfile, fixturePhase: mode === 'phase-blocked' ? 'ChampSelect' : 'None' });
      const result = JSON.parse(await runPowerShell(script, { input, timeoutMs: 12000 }));
      assert.equal(result.dismissed, mode === 'positive', JSON.stringify(result));
      assert.equal(result.foregroundUnchanged, true);
      assert.equal(result.cursorUnchanged, true);
      state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      assert.deepEqual(state, { mode, toastDismissed: mode === 'positive', decoyClicked: false, page: 'Original page' });
      if (mode === 'positive') {
        const again = JSON.parse(await runPowerShell(script, { input, timeoutMs: 12000 }));
        assert.equal(again.dismissed, false);
        assert.equal(again.candidates, 0);
      }
      if (mode === 'duplicate') assert.equal(result.reason, 'ambiguous-toast');
      if (mode === 'phase-blocked' || mode === 'session-changed') assert.equal(result.reason, mode);
    } finally {
      child.kill();
      await closed;
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('las-toast-test-'));
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
