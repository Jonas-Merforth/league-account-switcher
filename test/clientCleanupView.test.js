import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CLIENT_CLEANUP_DEFAULT_HINT,
  clientCleanupTftVisibleNote
} from '../src/renderer/clientCleanupView.js';

test('cleanup hint explains how to clear dots that are already visible', () => {
  assert.match(CLIENT_CLEANUP_DEFAULT_HINT, /Deep-clean visible dots/i);
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.equal(html.includes(CLIENT_CLEANUP_DEFAULT_HINT), true);
});

test('next-session TFT persistence does not hide the current visible-dot action', () => {
  const result = {
    tftLiveClearReasons: ['residual'],
    tftNextSessionReasons: ['residual'],
    tftOfferPlaceholderApplied: true,
    uiNavigation: {
      visitsSent: { tft: false }
    }
  };

  assert.match(clientCleanupTftVisibleNote(result), /still visible now/i);
  assert.equal(clientCleanupTftVisibleNote(result, { deep: true }), '');
  result.uiNavigation.visitsSent.tft = true;
  assert.equal(clientCleanupTftVisibleNote(result), '');
});
