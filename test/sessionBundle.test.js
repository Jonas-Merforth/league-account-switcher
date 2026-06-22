import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundlePrimaryYaml, readSessionBundle, writeSessionBundle } from '../src/core/sessionBundle.js';

function makeRiotClientDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'las-bundle-'));
  fs.mkdirSync(path.join(root, 'Data', 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Data', 'RiotGamesPrivateSettings.yaml'), 'riot-login:\n  persist:\n    cookies:\n    - name: ssid\n');
  fs.writeFileSync(path.join(root, 'Data', 'Sessions', 'session-1'), 'session-bytes');
  fs.writeFileSync(path.join(root, 'Config', 'RiotClientSettings.yaml'), 'region: EUW\n');
  // Items that must be excluded from a snapshot.
  fs.writeFileSync(path.join(root, 'Config', 'lockfile'), 'Riot Client:1:2:p:https');
  fs.writeFileSync(path.join(root, 'Config', 'ClientConfiguration.json'), '{"big":"cache"}');
  return root;
}

test('readSessionBundle captures the session set and excludes lockfile + ClientConfiguration', () => {
  const root = makeRiotClientDir();
  const manifest = readSessionBundle(root);
  const keys = Object.keys(manifest).sort();
  assert.deepEqual(keys, [
    'Config/RiotClientSettings.yaml',
    'Data/RiotGamesPrivateSettings.yaml',
    'Data/Sessions/session-1'
  ]);
  assert.equal(manifest['Config/lockfile'], undefined);
  assert.equal(manifest['Config/ClientConfiguration.json'], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bundlePrimaryYaml decodes the primary session yaml', () => {
  const root = makeRiotClientDir();
  const yaml = bundlePrimaryYaml(readSessionBundle(root));
  assert.match(yaml, /ssid/);
  assert.equal(bundlePrimaryYaml({}), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('writeSessionBundle restores every file byte-for-byte into a fresh root', () => {
  const source = makeRiotClientDir();
  const manifest = readSessionBundle(source);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'las-bundle-out-'));
  writeSessionBundle(manifest, target);
  assert.equal(
    fs.readFileSync(path.join(target, 'Data', 'RiotGamesPrivateSettings.yaml'), 'utf8'),
    fs.readFileSync(path.join(source, 'Data', 'RiotGamesPrivateSettings.yaml'), 'utf8')
  );
  assert.equal(fs.readFileSync(path.join(target, 'Data', 'Sessions', 'session-1'), 'utf8'), 'session-bytes');
  assert.equal(fs.readFileSync(path.join(target, 'Config', 'RiotClientSettings.yaml'), 'utf8'), 'region: EUW\n');
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});
