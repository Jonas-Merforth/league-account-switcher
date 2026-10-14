import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LcuClient } from '../src/core/lcu.js';

test('a multi-request LCU operation cannot cross into the next account session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcu-session-'));
  try {
    const lockfile = path.join(dir, 'lockfile');
    fs.writeFileSync(lockfile, 'LeagueClient:123:456:fixture-first:https');
    const shared = new LcuClient({ leaguePath: dir });
    const operation = shared.forCurrentSession();
    assert.equal(operation.getCredentials().port, 456);
    // Even a reused PID/port cannot silently continue with a rotated credential.
    fs.writeFileSync(lockfile, 'LeagueClient:123:456:fixture-second:https');
    assert.throws(() => operation.getCredentials(), { code: 'LCU_SESSION_CHANGED' });
    assert.equal(shared.forCurrentSession().getCredentials().password, 'fixture-second');
    assert.throws(() => operation.getCredentials(), { code: 'LCU_SESSION_CHANGED' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
