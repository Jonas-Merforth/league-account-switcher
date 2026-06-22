import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPorofessorLiveUrl, resolvePorofessorRegion } from '../src/core/porofessor.js';

test('resolvePorofessorRegion prefers webRegion, then platform-id fallback, then raw', () => {
  assert.equal(resolvePorofessorRegion({ webRegion: 'EUW' }), 'euw');
  assert.equal(resolvePorofessorRegion({ region: 'euw1' }), 'euw'); // platform id -> web code
  assert.equal(resolvePorofessorRegion({ region: 'euw' }), 'euw');
  assert.equal(resolvePorofessorRegion({}), '');
});

test('buildPorofessorLiveUrl builds a live URL and encodes the Riot ID', () => {
  assert.equal(
    buildPorofessorLiveUrl({ gameName: 'Hide on bush', tagLine: 'KR1', region: 'kr' }),
    'https://porofessor.gg/live/kr/Hide%20on%20bush-KR1'
  );
  assert.throws(() => buildPorofessorLiveUrl({ gameName: '', tagLine: 'x', region: 'euw' }), /Riot ID/);
  assert.throws(() => buildPorofessorLiveUrl({ gameName: 'A', tagLine: 'B', region: '' }), /region/);
});
