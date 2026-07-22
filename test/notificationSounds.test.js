import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getNotificationSounds,
  MAX_NOTIFICATION_SOUND_BYTES,
  resetNotificationSound,
  saveNotificationSound
} from '../src/core/notificationSounds.js';

function temporarySoundDir(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'las-notification-sounds-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function soundBytes(sound) {
  return [...(sound.data || [])];
}

test('notification sounds start on independent built-in defaults', (t) => {
  const rootDir = temporarySoundDir(t);
  const sounds = getNotificationSounds({ rootDir });

  assert.deepEqual(sounds.accept, {
    kind: 'accept', custom: false, name: null, mimeType: null, size: 0, data: null
  });
  assert.deepEqual(sounds.dodge, {
    kind: 'dodge', custom: false, name: null, mimeType: null, size: 0, data: null
  });
  assert.equal(MAX_NOTIFICATION_SOUND_BYTES, 25 * 1024 * 1024);
  assert.throws(
    () => saveNotificationSound('other', { name: 'bad.wav', data: new Uint8Array([1]) }, { rootDir }),
    /Unknown notification sound type/
  );
  assert.throws(() => resetNotificationSound('other', { rootDir }), /Unknown notification sound type/);
});

test('saving, replacing, reloading, and resetting keep accept and dodge separate', (t) => {
  const rootDir = temporarySoundDir(t);
  const accept = saveNotificationSound('accept', {
    name: 'C:\\Sounds\\queue.wav',
    mimeType: 'audio/wav',
    data: new Uint8Array([1, 2, 3])
  }, { rootDir });
  const dodge = saveNotificationSound('dodge', {
    name: 'dodge.ogg',
    mimeType: 'audio/ogg',
    data: new Uint8Array([4, 5])
  }, { rootDir });

  assert.equal(accept.name, 'queue.wav');
  assert.equal(accept.mimeType, 'audio/wav');
  assert.deepEqual(soundBytes(accept), [1, 2, 3]);
  assert.equal(dodge.name, 'dodge.ogg');

  const replaced = saveNotificationSound('accept', {
    name: '../../replacement.mp3',
    mimeType: 'AUDIO/MPEG',
    data: new Uint8Array([9, 8, 7, 6])
  }, { rootDir });
  assert.equal(replaced.name, 'replacement.mp3');
  assert.equal(replaced.mimeType, 'audio/mpeg');
  assert.deepEqual(soundBytes(replaced), [9, 8, 7, 6]);

  const files = fs.readdirSync(rootDir);
  assert.equal(files.filter((file) => file.startsWith('accept-')).length, 1);
  assert.equal(files.filter((file) => file.startsWith('dodge-')).length, 1);
  const manifest = fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifest, /\.\./);

  const reloaded = getNotificationSounds({ rootDir });
  assert.deepEqual(soundBytes(reloaded.accept), [9, 8, 7, 6]);
  assert.deepEqual(soundBytes(reloaded.dodge), [4, 5]);

  assert.equal(resetNotificationSound('accept', { rootDir }).custom, false);
  const afterAcceptReset = getNotificationSounds({ rootDir });
  assert.equal(afterAcceptReset.accept.custom, false);
  assert.equal(afterAcceptReset.dodge.custom, true);
  assert.deepEqual(soundBytes(afterAcceptReset.dodge), [4, 5]);

  assert.equal(resetNotificationSound('dodge', { rootDir }).custom, false);
  assert.equal(getNotificationSounds({ rootDir }).dodge.custom, false);
});

test('empty, oversized, and invalid payloads do not replace the current sound', (t) => {
  const rootDir = temporarySoundDir(t);
  const options = { rootDir, maxBytes: 4 };
  saveNotificationSound('accept', {
    name: 'boundary.wav',
    mimeType: 'audio/wav',
    data: new Uint8Array([1, 2, 3, 4])
  }, options);

  assert.throws(
    () => saveNotificationSound('accept', { name: 'empty.wav', data: new Uint8Array() }, options),
    /empty/
  );
  assert.throws(
    () => saveNotificationSound('accept', { name: 'large.wav', data: new Uint8Array(5) }, options),
    /larger than 25 MB/
  );
  assert.throws(
    () => saveNotificationSound('accept', { name: 'invalid.wav', data: {} }, options),
    /data is invalid/
  );
  assert.deepEqual(soundBytes(getNotificationSounds(options).accept), [1, 2, 3, 4]);
});

test('missing files and corrupt manifests safely fall back to defaults', (t) => {
  const rootDir = temporarySoundDir(t);
  saveNotificationSound('accept', {
    name: 'queue.wav',
    mimeType: 'audio/wav',
    data: new Uint8Array([1, 2, 3])
  }, { rootDir });
  const managedFile = fs.readdirSync(rootDir).find((file) => file.startsWith('accept-'));
  fs.unlinkSync(path.join(rootDir, managedFile));
  assert.equal(getNotificationSounds({ rootDir }).accept.custom, false);

  fs.writeFileSync(path.join(rootDir, 'manifest.json'), '{broken', 'utf8');
  const sounds = getNotificationSounds({ rootDir });
  assert.equal(sounds.accept.custom, false);
  assert.equal(sounds.dodge.custom, false);
});
