import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyBaseline, applyBaselineToClient, captureBaseline, captureLiveBaseline,
  getBaselineMeta, hasBaseline, settingsPatch, unlockConfig
} from '../src/core/settingsSync.js';

const previous = process.env.LCA_CONFIG_DIR;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'las-settings-sync-'));
process.env.LCA_CONFIG_DIR = path.join(root, 'store');
const leaguePath = path.join(root, 'League');
const config = path.join(leaguePath, 'Config');
const baseline = path.join(process.env.LCA_CONFIG_DIR, 'settings-baseline');
const fixture = (value = '1') => ({ files: [
  { name: 'Game.cfg', sections: [{ name: 'HUD', settings: [
    { name: 'ShowSpellCosts', value }, { name: 'Scale', value: '0.75' }, { name: 'RemovedSetting', value: '1' }
  ] }] },
  { name: 'Input.ini', sections: [{ name: 'GameEvents', settings: [{ name: 'evtCastSpell1', value: '[q]' }] }] }
] });
function writeFixture(value = '1') {
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'PersistedSettings.json'), JSON.stringify(fixture(value)));
  fs.writeFileSync(path.join(config, 'game.cfg'), '[HUD]\nShowSpellCosts=' + value);
}
test.beforeEach(() => {
  unlockConfig(leaguePath);
  fs.rmSync(config, { force: true, recursive: true });
  fs.rmSync(baseline, { force: true, recursive: true });
  writeFixture();
});
test.after(() => {
  unlockConfig(leaguePath);
  fs.rmSync(root, { force: true, recursive: true });
  if (previous === undefined) delete process.env.LCA_CONFIG_DIR;
  else process.env.LCA_CONFIG_DIR = previous;
});

test('invalid saves preserve the last complete snapshot; missing optional files do not leak from older captures', () => {
  fs.writeFileSync(path.join(config, 'input.ini'), 'old input');
  captureBaseline(leaguePath, { account: 'First' });
  const good = fs.readFileSync(path.join(baseline, 'snapshot.json'), 'utf8');
  fs.writeFileSync(path.join(config, 'PersistedSettings.json'), '{');
  assert.throws(() => captureBaseline(leaguePath, { account: 'Partial' }));
  assert.equal(fs.readFileSync(path.join(baseline, 'snapshot.json'), 'utf8'), good);
  assert.equal(getBaselineMeta().account, 'First');
  writeFixture('0');
  fs.rmSync(path.join(config, 'input.ini'));
  captureBaseline(leaguePath, { account: 'Second' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(baseline, 'snapshot.json'))).files['input.ini'], undefined);
  assert.deepEqual(fs.readdirSync(baseline), ['snapshot.json']);
});

test('legacy baselines remain usable and become atomic snapshots after capture', () => {
  fs.mkdirSync(baseline, { recursive: true });
  fs.writeFileSync(path.join(baseline, 'PersistedSettings.json'), JSON.stringify(fixture()));
  fs.writeFileSync(path.join(baseline, 'baseline.json'), JSON.stringify({ account: 'Legacy' }));
  assert.equal(hasBaseline(), true);
  assert.equal(getBaselineMeta().account, 'Legacy');
  captureBaseline(leaguePath, { account: 'Current' });
  assert.equal(getBaselineMeta().account, 'Current');
});

test('file values map to supported API types while unknown keys remain excluded', () => {
  assert.deepEqual(settingsPatch(fixture(), 'game.cfg', { HUD: { ShowSpellCosts: false, Scale: 1 } }),
    { HUD: { ShowSpellCosts: true, Scale: 0.75 } });
  assert.deepEqual(settingsPatch(fixture(), 'input.ini', { GameEvents: { evtCastSpell1: '[w]' } }),
    { GameEvents: { evtCastSpell1: '[q]' } });
});

function client({ ready = [true], phase = 'None', ignorePatch = false } = {}) {
  const calls = [];
  const resources = {
    'game-settings': { HUD: { ShowSpellCosts: false, Scale: 1 } },
    'input-settings': { GameEvents: { evtCastSpell1: '[w]' } }
  };
  return { calls, resources,
    async get(endpoint) {
      calls.push(['get', endpoint]);
      if (endpoint.endsWith('/ready')) return ready.length > 1 ? ready.shift() : ready[0];
      if (endpoint.endsWith('/gameflow-phase')) return phase;
      if (endpoint.endsWith('/current-summoner')) return { puuid: 'fixture-puuid', gameName: 'Current', tagLine: 'TEST' };
      return structuredClone(resources[endpoint.split('/').at(-1)]);
    },
    async patch(endpoint, body) {
      calls.push(['patch', endpoint, body]);
      if (!ignorePatch) resources[endpoint.split('/').at(-1)] = structuredClone(body.data);
    },
    async post(endpoint) { calls.push(['post', endpoint]); }
  };
}

test('settings wait for account readiness then update and verify both resource types; files remain writable', async () => {
  captureBaseline(leaguePath);
  applyBaseline(leaguePath);
  const lcu = client({ ready: [false, false, true] });
  let waits = 0;
  await applyBaselineToClient(lcu, leaguePath, { waitFor: async () => { waits++; } });
  assert.equal(waits, 2);
  assert.equal(lcu.resources['game-settings'].HUD.ShowSpellCosts, true);
  assert.equal(lcu.resources['input-settings'].GameEvents.evtCastSpell1, '[q]');
  assert.equal(lcu.calls.at(-1)[1], '/lol-game-settings/v1/save');
  fs.writeFileSync(path.join(config, 'game.cfg'), 'writable after successful sync');
});

test('rejected settings and readiness timeouts release every file lock', async () => {
  captureBaseline(leaguePath);
  for (const lcu of [client({ ignorePatch: true }), client({ ready: [false] }), client({ phase: 'InProgress' })]) {
    applyBaseline(leaguePath);
    await assert.rejects(applyBaselineToClient(lcu, leaguePath, { attempts: 1, waitFor: async () => {} }));
    for (const name of ['game.cfg', 'PersistedSettings.json']) {
      fs.writeFileSync(path.join(config, name), fs.readFileSync(path.join(config, name)));
    }
  }
});

test('outgoing capture reloads and flushes disk changes even if they differ from the old baseline', async () => {
  captureBaseline(leaguePath, { account: 'Old' });
  writeFixture('0');
  const lcu = client();
  await captureLiveBaseline(lcu, leaguePath);
  assert.deepEqual(lcu.calls.filter(([method]) => method === 'post').map(([, endpoint]) => endpoint),
    ['/lol-game-settings/v1/reload-post-game', '/lol-game-settings/v1/save']);
  assert.equal(getBaselineMeta().account, 'Current#TEST');
  writeFixture('1');
  applyBaseline(leaguePath);
  assert.match(fs.readFileSync(path.join(config, 'game.cfg'), 'utf8'), /ShowSpellCosts=0/);
});

test('unknown phases, live games, and unloaded accounts never replace a good baseline', async () => {
  captureBaseline(leaguePath, { account: 'Keep' });
  for (const lcu of [client({ phase: null }), client({ phase: 'InProgress' }), client({ ready: [false] })]) {
    assert.equal(await captureLiveBaseline(lcu, leaguePath), null);
    assert.equal(lcu.calls.some(([method]) => method === 'post'), false);
  }
  assert.equal(getBaselineMeta().account, 'Keep');
});

test('cancelling a delayed capture during its save prevents it replacing the baseline', async () => {
  captureBaseline(leaguePath, { account: 'Keep' });
  let cancelled = false;
  const lcu = client();
  lcu.post = async (endpoint) => { if (endpoint.endsWith('/save')) cancelled = true; };
  await assert.rejects(captureLiveBaseline(lcu, leaguePath, {
    assertCurrent: () => { if (cancelled) throw new Error('cancelled'); }
  }), /cancelled/);
  assert.equal(getBaselineMeta().account, 'Keep');
});
