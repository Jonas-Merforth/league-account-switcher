import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLeagueLockfileLive, isProcessIdRunning } from '../src/core/leagueRuntime.js';

test('process liveness accepts running and inaccessible PIDs but rejects missing ones', () => {
  assert.equal(isProcessIdRunning(42, () => {}), true);
  assert.equal(isProcessIdRunning(42, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }), true);
  assert.equal(isProcessIdRunning(42, () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); }), false);
  assert.equal(isProcessIdRunning('not-a-pid', () => {}), false);
});

test('League lockfile is live only while its recorded process exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'league-runtime-'));
  const lockfile = path.join(root, 'lockfile');
  try {
    fs.writeFileSync(lockfile, 'LeagueClient:56124:56793:secret:https');
    assert.equal(isLeagueLockfileLive(lockfile, { signalProcess: (pid, signal) => {
      assert.equal(pid, 56124);
      assert.equal(signal, 0);
    } }), true);
    assert.equal(isLeagueLockfileLive(lockfile, { signalProcess: () => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    } }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing and malformed League lockfiles are not live', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'league-runtime-'));
  const lockfile = path.join(root, 'lockfile');
  try {
    assert.equal(isLeagueLockfileLive(lockfile), false);
    fs.writeFileSync(lockfile, 'not-a-lockfile');
    assert.equal(isLeagueLockfileLive(lockfile, { signalProcess: () => {} }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
