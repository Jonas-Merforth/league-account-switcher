import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceCollector, requestEvidenceReplay } from './liveProfileEvidence.js';

test('only an unfamiliar build starts a capture, once per game, with dodge cleanup', async () => {
  let known = true, enabled = true, starts = 0, stops = 0;
  const recorder = { capture: { busy: false },
    start() { this.sessionDirectory = String(++starts); this.capture.busy = true; },
    stop() { stops++; this.capture.busy = false; } };
  const tick = evidenceCollector({ recorder, known: () => known, version: async () => '16.99.1.2',
    enabled: () => enabled, log: assert.fail });
  await tick('ChampSelect');
  await tick('InProgress');
  assert.equal(starts, 0);
  await tick('Lobby');
  known = false;
  enabled = false;
  await tick('ChampSelect');
  assert.equal(starts, 0);
  enabled = true;
  await tick('ChampSelect');
  await tick('Lobby');
  assert.equal(stops, 1);
  await tick('ChampSelect');
  await tick('GameStart');
  recorder.stop();
  await tick('Reconnect');
  await tick('WaitingForStats');
  assert.equal(starts, 2);
  assert.equal(stops, 2);
});

test('replay request retries an unavailable replay and stops when the signed-in session changes', async () => {
  let attempts = 0, waits = 0;
  const client = { async request(method, endpoint, body, options) {
    assert.equal(method, 'POST');
    assert.equal(endpoint, '/lol-replays/v1/rofls/123/download');
    assert.deepEqual(body, { componentType: 'replay-button' });
    assert.equal(options.allowMissing, false);
    if (++attempts === 1) throw new Error('404');
  } };
  const wait = async delay => { assert.equal(delay, 15000); waits++; };
  await requestEvidenceReplay(client, '123', wait);
  assert.equal(attempts, 2);
  client.request = async () => { throw Object.assign(new Error('account changed'), { code: 'LCU_SESSION_CHANGED' }); };
  await assert.rejects(requestEvidenceReplay(client, '123', wait), /account changed/);
  assert.equal(waits, 1);
});
