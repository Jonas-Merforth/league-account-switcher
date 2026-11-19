import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalLiveProfiles, protocol16_23, protocolForBuild, protocolForObserver } from './liveProtocol.js';
import { readDamageProtocol } from './damageWire.js';
import { KeyframeSnapshotDecoder } from './spectator/keyframe-snapshot-decoder.js';

test('a data-only update works in the damage and spectator entry points and isolates bad files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'league-profiles-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    loadLocalLiveProfiles(dir, assert.fail);
  });
  const base = JSON.parse(readFileSync(new URL('./protocols/16.23.839.6405.json', import.meta.url)));
  const write = source => writeFileSync(join(dir, source.build + '.json'), JSON.stringify(source));
  const build = '88.1.555.123';
  const alias = '16.23.839.9998';
  write({ ...base, build, hotfixBuilds: [] });
  write({ ...base, hotfixBuilds: [alias] });
  write({ ...base, build: '88.2.555.123', hotfixBuilds: [], partial: true });
  write({ ...base, build: '88.3.555.123', hotfixBuilds: [], ids: { ...base.ids, marker: base.ids.display } });
  writeFileSync(join(dir, 'broken.json'), '{');
  const errors = [];
  loadLocalLiveProfiles(dir, name => errors.push(name));
  assert.deepEqual(errors.sort(), ['88.2.555.123.json', '88.3.555.123.json', 'broken.json']);
  const installed = readDamageProtocol('Build Version: Version ' + build);
  assert.deepEqual(installed.fields.decodeDamageBatch(Buffer.from('a60335d5350b93ce1c', 'hex'))
    .map(b => b.toString('hex')), ['2f', 'aca6']);
  assert.equal(protocolForObserver('88.1'), installed);
  new KeyframeSnapshotDecoder().assertSupportsContext(build, { queueId: 420 });
  assert.equal(protocolForBuild('88.1.555.124'), null);
  assert.equal(protocolForObserver('16.23'), protocolForBuild(alias));
  assert.equal(protocolForBuild('16.23.8399929'), protocolForBuild(alias));

  write({ ...base, secondaryTimestamp: !base.secondaryTimestamp, hotfixBuilds: [alias] });
  loadLocalLiveProfiles(dir, () => {});
  assert.equal(protocolForBuild(alias), null);
  assert.equal(protocolForBuild(base.build), protocol16_23);
});
