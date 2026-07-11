import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getBetaConfigDir,
  getConfigDir,
  getLogPath,
  getReleaseConfigDir,
  initializeBetaConfigFromRelease
} from '../src/core/config.js';

test('beta uses an isolated config/log and imports release data once without writing back', () => {
  const originalAppData = process.env.APPDATA;
  const originalChannel = process.env.LAS_BUILD_CHANNEL;
  const originalOverride = process.env.LCA_CONFIG_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'las-beta-config-'));
  try {
    process.env.APPDATA = root;
    process.env.LAS_BUILD_CHANNEL = 'beta';
    delete process.env.LCA_CONFIG_DIR;
    const release = getReleaseConfigDir();
    fs.mkdirSync(path.join(release, 'accounts', 'a1'), { recursive: true });
    fs.writeFileSync(path.join(release, 'accounts.json'), '[{"id":"a1","label":"Main"}]\n');
    fs.writeFileSync(path.join(release, 'accounts', 'a1', 'session.enc'), 'encrypted');
    fs.writeFileSync(path.join(release, 'switcher-settings.json'), JSON.stringify({ startWithWindows: true, autoUpdate: true }));

    const result = initializeBetaConfigFromRelease();
    const beta = getBetaConfigDir();
    assert.equal(result.copied, true);
    assert.equal(getConfigDir(), beta);
    assert.equal(getLogPath(), path.join(beta, 'switcher-beta.log'));
    assert.equal(fs.readFileSync(path.join(beta, 'accounts', 'a1', 'session.enc'), 'utf8'), 'encrypted');
    const settings = JSON.parse(fs.readFileSync(path.join(beta, 'switcher-settings.json'), 'utf8'));
    assert.equal(settings.startWithWindows, false);
    assert.equal(settings.autoUpdate, false);

    fs.writeFileSync(path.join(beta, 'accounts.json'), 'beta-only');
    assert.equal(initializeBetaConfigFromRelease().reason, 'already-imported');
    assert.match(fs.readFileSync(path.join(release, 'accounts.json'), 'utf8'), /Main/);
  } finally {
    if (originalAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = originalAppData;
    if (originalChannel === undefined) delete process.env.LAS_BUILD_CHANNEL; else process.env.LAS_BUILD_CHANNEL = originalChannel;
    if (originalOverride === undefined) delete process.env.LCA_CONFIG_DIR; else process.env.LCA_CONFIG_DIR = originalOverride;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
