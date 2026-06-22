import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpggProfileUrl } from '../src/core/opgg.js';
import { buildPorofessorLiveUrl } from '../src/core/porofessor.js';

test('buildOpggProfileUrl matches the op.gg profile format, lowercases region, encodes spaces', () => {
  assert.equal(
    buildOpggProfileUrl({ gameName: 'Azir to Plat', tagLine: 'EUW', region: 'EUW' }),
    'https://op.gg/lol/summoners/euw/Azir%20to%20Plat-EUW'
  );
  assert.throws(() => buildOpggProfileUrl({ gameName: '', tagLine: 'x', region: 'euw' }), /Riot ID/);
  assert.throws(() => buildOpggProfileUrl({ gameName: 'A', tagLine: 'B', region: '' }), /region/);
});

test('both builders percent-encode special characters in the Riot ID', () => {
  const id = { gameName: 'a b&c#é/?', tagLine: 'NA 1', region: 'na' };
  const seg = `${encodeURIComponent('a b&c#é/?')}-${encodeURIComponent('NA 1')}`;
  assert.equal(buildOpggProfileUrl(id), `https://op.gg/lol/summoners/na/${seg}`);
  assert.equal(buildPorofessorLiveUrl(id), `https://porofessor.gg/live/na/${seg}`);

  // No raw space / reserved character may leak into the final path segment.
  for (const url of [buildOpggProfileUrl(id), buildPorofessorLiveUrl(id)]) {
    const lastSegment = url.slice(url.lastIndexOf('/') + 1);
    assert.doesNotMatch(lastSegment, /[ #&?/]/);
  }
});
