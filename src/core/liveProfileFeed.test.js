import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveProfileFeed } from './liveProfileFeed.js';
import { DamageRecorder } from './damageRecorder.js';
import { loadLocalLiveProfiles, protocolForBuild } from './liveProtocol.js';
import { KeyframeSnapshotDecoder } from './spectator/keyframe-snapshot-decoder.js';

const bundled = JSON.parse(readFileSync(new URL('./protocols/16.23.839.6405.json', import.meta.url)));
const profile = { ...bundled, build: '87.2.123.456', hotfixBuilds: [] };
const raw = JSON.stringify({ version: 1, profiles: [profile] });
const directoryFor = t => {
  const directory = mkdtempSync(join(tmpdir(), 'protocol-feed-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    loadLocalLiveProfiles(directory, assert.fail);
  });
  return directory;
};

test('managed HTTPS feed activates in existing consumers, caches offline and rejects a bad replacement', async t => {
  const directory = directoryFor(t);
  const decoder = new KeyframeSnapshotDecoder();
  const version = profile.build;
  assert.throws(() => decoder.assertSupportsContext(version, { queueId: 420 }));
  let clock = 0, calls = 0, response = raw;
  const errors = [];
  const opts = { directory, url: 'https://example.test/live-profiles.json', now: () => clock, log: e => errors.push(e),
    request: async (_url, options) => {
      if (calls++) assert.equal(options.headers['If-None-Match'], '"rev1"');
      return response === null ? new Response(null, { status: 304 }) : new Response(response, { headers: { etag: '"rev1"' } });
    } };
  const feed = liveProfileFeed(opts);
  await Promise.all([feed.check(), feed.check()]);
  assert.equal(calls, 1);
  decoder.assertSupportsContext(version, { queueId: 420 });
  assert.equal(protocolForBuild(version).batch, profile.ids.batch);
  clock += 300000;
  response = null;
  await feed.check();
  const data = readFileSync(join(directory, 'verified-live-feed.json'), 'utf8');
  clock += 300000;
  response = JSON.stringify({ version: 1, profiles: [profile, { ...profile, build: '87.3.123.456', partial: true }] });
  await feed.check();
  assert.equal(errors.length, 1);
  assert.equal(readFileSync(join(directory, 'verified-live-feed.json'), 'utf8'), data);
  assert.equal(protocolForBuild('87.3.123.456'), null);
  liveProfileFeed(opts);
  assert.ok(protocolForBuild(version));
});

test('local worker output applies without a server or restart', async t => {
  let recorder;
  t.after(() => recorder?.shutdown());
  const directory = directoryFor(t);
  const feed = liveProfileFeed({ directory, log: assert.fail, request: assert.fail });
  recorder = new DamageRecorder({ directory, leaguePath: () => directory,
    captureFactory: () => ({ busy: false,
      start() { this.busy = true; }, stop() { this.busy = false; } }) });
  recorder.start();
  recorder.logSource = join(directory, 'game.log');
  writeFileSync(recorder.logSource, 'Build Version: Version ' + profile.build + '\nCommand "127.0.0.1 8080 YWJjZA== 1"');
  recorder.pollLive();
  assert.equal(recorder.unsupportedBuild, profile.build);
  writeFileSync(join(directory, 'live-profiles.json'), raw);
  await feed.check();
  recorder.pollLive();
  assert.equal(recorder.live.protocol.build, profile.build);
  assert.equal(recorder.unsupportedBuild, null);
  assert.ok(protocolForBuild(profile.build));
  assert.equal(protocolForBuild('87.2.123.457'), null);
});
