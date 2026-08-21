import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RiotClientApi } from '../src/core/riotClient.js';

test('Riot Client is running only while the lockfile owner process exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'riot-client-runtime-'));
  const lockfile = path.join(root, 'lockfile');
  try {
    fs.writeFileSync(lockfile, 'Riot Client:31552:62163:secret:https');
    const live = new RiotClientApi({
      getLockfilePath: () => lockfile,
      isProcessRunning: (pid) => pid === 31552
    });
    const stale = new RiotClientApi({
      getLockfilePath: () => lockfile,
      isProcessRunning: () => false
    });
    assert.equal(live.isRunning(), true);
    assert.equal(stale.isRunning(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing and malformed Riot Client lockfiles are not running', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'riot-client-runtime-'));
  const lockfile = path.join(root, 'lockfile');
  try {
    const api = new RiotClientApi({
      getLockfilePath: () => lockfile,
      isProcessRunning: () => true
    });
    assert.equal(api.isRunning(), false);
    fs.writeFileSync(lockfile, 'not-a-lockfile');
    assert.equal(api.isRunning(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
