import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRankedQueue, parseRankedStats, fetchCurrentRanks } from '../src/core/rankedStats.js';

const soloEntry = { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', division: 'III', leaguePoints: 85, wins: 18, losses: 21 };
const flexEntry = { queueType: 'RANKED_FLEX_SR', tier: 'EMERALD', division: 'II', leaguePoints: 13, wins: 26, losses: 20 };

test('parseRankedQueue maps a ranked entry to the stored shape', () => {
  assert.deepEqual(parseRankedQueue(soloEntry), { tier: 'GOLD', division: 3, lp: 85, wins: 18, losses: 21 });
});

test('parseRankedQueue treats unranked and unknown tiers as null', () => {
  assert.equal(parseRankedQueue({ tier: '', division: 'NA' }), null);
  assert.equal(parseRankedQueue({ tier: 'NONE', division: 'NA' }), null);
  assert.equal(parseRankedQueue({ tier: 'UNRANKED' }), null);
  assert.equal(parseRankedQueue(null), null);
  assert.equal(parseRankedQueue({}), null);
});

test('parseRankedQueue handles apex tiers without a division', () => {
  const master = parseRankedQueue({ tier: 'MASTER', division: 'NA', leaguePoints: 245, wins: 100, losses: 90 });
  assert.deepEqual(master, { tier: 'MASTER', division: null, lp: 245, wins: 100, losses: 90 });
});

test('parseRankedQueue maps roman divisions I-IV and tolerates junk', () => {
  assert.equal(parseRankedQueue({ ...soloEntry, division: 'I' }).division, 1);
  assert.equal(parseRankedQueue({ ...soloEntry, division: 'IV' }).division, 4);
  assert.equal(parseRankedQueue({ ...soloEntry, division: 'NA' }).division, null);
  assert.equal(parseRankedQueue({ ...soloEntry, division: undefined }).division, null);
  assert.equal(parseRankedQueue({ ...soloEntry, leaguePoints: 'x' }).lp, 0);
});

test('parseRankedStats extracts solo and flex from the queues array', () => {
  const parsed = parseRankedStats({ queues: [flexEntry, soloEntry, { queueType: 'RANKED_TFT', tier: 'DIAMOND' }] });
  assert.equal(parsed.solo.tier, 'GOLD');
  assert.equal(parsed.flex.tier, 'EMERALD');
});

test('parseRankedStats marks queues unranked but only when the payload has data', () => {
  const parsed = parseRankedStats({ queues: [soloEntry, { queueType: 'RANKED_FLEX_SR', tier: '', division: 'NA' }] });
  assert.equal(parsed.solo.tier, 'GOLD');
  assert.equal(parsed.flex, null);
});

test('parseRankedStats returns null for unusable payloads (caller retries, never stores unranked)', () => {
  assert.equal(parseRankedStats(null), null);
  assert.equal(parseRankedStats({}), null);
  assert.equal(parseRankedStats({ queues: [] }), null);
  assert.equal(parseRankedStats({ queues: [{ queueType: 'RANKED_TFT' }] }), null);
});

test('parseRankedStats falls back to queueMap when queues is absent', () => {
  const parsed = parseRankedStats({ queueMap: { RANKED_SOLO_5x5: soloEntry, RANKED_FLEX_SR: flexEntry } });
  assert.equal(parsed.solo.tier, 'GOLD');
  assert.equal(parsed.flex.division, 2);
});

test('fetchCurrentRanks resolves null on a 404 payload and parses real ones', async () => {
  assert.equal(await fetchCurrentRanks({ get: async () => null }), null);
  const ranks = await fetchCurrentRanks({ get: async () => ({ queues: [soloEntry] }) });
  assert.equal(ranks.solo.tier, 'GOLD');
  assert.equal(ranks.flex, null);
});
