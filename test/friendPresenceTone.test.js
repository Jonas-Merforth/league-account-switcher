import test from 'node:test';
import assert from 'node:assert/strict';
import { friendPresenceTone } from '../src/renderer/friendPresenceTone.js';

test('friendPresenceTone maps friend states to client-like colors', () => {
  assert.equal(friendPresenceTone({ online: true, state: 'chat' }), 'online');
  assert.equal(friendPresenceTone({ online: true, activity: { kind: 'lobby' } }), 'online');
  assert.equal(friendPresenceTone({ online: true, activity: { kind: 'queue' } }), 'online');
  assert.equal(friendPresenceTone({ online: true, state: 'away' }), 'away');
  assert.equal(friendPresenceTone({ online: true, activity: { kind: 'away' } }), 'away');
  assert.equal(friendPresenceTone({ online: true, state: 'dnd' }), 'ingame');
  assert.equal(friendPresenceTone({ online: true, activity: { kind: 'inGame' } }), 'ingame');
  assert.equal(friendPresenceTone({ online: true, activity: { kind: 'champSelect' } }), 'ingame');
  assert.equal(friendPresenceTone({ online: true, state: 'mobile' }), 'mobile');
  assert.equal(friendPresenceTone({ online: false, state: 'offline' }), 'offline');
});
