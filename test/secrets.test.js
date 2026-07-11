import test from 'node:test';
import assert from 'node:assert/strict';
import { dpapiProtect, dpapiUnprotectMany } from '../src/core/secrets.js';

test('DPAPI batch decrypt preserves input order', { skip: process.platform !== 'win32' }, async () => {
  const values = ['first saved session', 'second saved session', 'third saved session'];
  const encrypted = await Promise.all(values.map((value) => dpapiProtect(value)));
  assert.deepEqual(await dpapiUnprotectMany(encrypted), values);
});
