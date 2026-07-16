import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBackgroundHeaderClickScript } from '../src/core/leagueBackgroundClicks.js';
import { createLayeredHeaderClear } from '../src/core/leagueHeaderClear.js';
import { LEAGUE_HEADER_RATIOS, TFT_SUBNAV_RATIOS } from '../src/core/leagueHeaderClicks.js';

test('background click script posts messages to the CEF window without touching focus or cursor', () => {
  const script = buildBackgroundHeaderClickScript({ collection: true, tft: true });

  assert.match(script, /Chrome_RenderWidgetHostHWND/);
  assert.match(script, /WM_MOUSEMOVE = 0x0200/);
  assert.match(script, /WM_LBUTTONDOWN = 0x0201/);
  assert.match(script, /WM_LBUTTONUP = 0x0202/);
  assert.match(script, /SW_SHOWNOACTIVATE/);
  assert.match(script, /SW_SHOWMINNOACTIVE/);
  // Coordinates are client-relative (lParam packs y in the high word) and come from the CEF
  // child's client rect, not the top-level window rect.
  assert.match(script, /-shl 16/);
  assert.match(script, /GetClientRect/);
  assert.match(script, /LeagueClientUx/);
  assert.match(script, /background-clicks-ok/);

  // The entire point of this script: never activate the window or move the real cursor.
  assert.doesNotMatch(script, /SetForegroundWindow/);
  assert.doesNotMatch(script, /SetCursorPos/);
  assert.doesNotMatch(script, /mouse_event/);
});

test('background click script visits requested headers and ends on League home', () => {
  const script = buildBackgroundHeaderClickScript({ collection: true, tft: true });
  const clickLine = (ratio) => `Invoke-BackgroundClick ${ratio.x} ${ratio.y}`;
  const collectionAt = script.indexOf(clickLine(LEAGUE_HEADER_RATIOS.collection));
  const tftAt = script.indexOf(clickLine(LEAGUE_HEADER_RATIOS.tft));
  const homeAt = script.indexOf(clickLine(LEAGUE_HEADER_RATIOS.league));
  assert.ok(collectionAt > -1);
  assert.ok(tftAt > -1);
  assert.ok(homeAt > tftAt && homeAt > collectionAt, 'League home must be the final click');

  const tftOnly = buildBackgroundHeaderClickScript({ tft: true });
  assert.equal(tftOnly.includes(clickLine(LEAGUE_HEADER_RATIOS.collection)), false);
  assert.equal(tftOnly.includes(clickLine(LEAGUE_HEADER_RATIOS.league)), true);

  const store = buildBackgroundHeaderClickScript({ tft: true, tftStore: true });
  const storeHeaderAt = store.indexOf(clickLine(LEAGUE_HEADER_RATIOS.tft));
  const storeSubnavAt = store.indexOf(clickLine(TFT_SUBNAV_RATIOS.store));
  const storeHomeAt = store.indexOf(clickLine(LEAGUE_HEADER_RATIOS.league));
  assert.ok(storeHeaderAt > -1 && storeSubnavAt > storeHeaderAt);
  assert.ok(storeHomeAt > storeSubnavAt, 'TFT Store acknowledgement must still end on League home');
});

test('header clear uses the background clicker', async () => {
  const calls = [];
  const clear = createLayeredHeaderClear({
    background: async (targets) => {
      calls.push(['background', targets]);
      return { collection: Boolean(targets.collection), tft: Boolean(targets.tft) };
    },
    foreground: async (targets) => {
      calls.push(['foreground', targets]);
      return { collection: Boolean(targets.collection), tft: Boolean(targets.tft) };
    }
  });

  const result = await clear({ collection: true, tft: true });
  assert.deepEqual(result, { collection: true, tft: true, mode: 'background' });
  assert.deepEqual(calls, [['background', { collection: true, tft: true }]]);
});

test('header clear logs and rethrows background failures without using the foreground clicker', async () => {
  const logs = [];
  const backgroundError = new Error('PostMessage down failed for TFT');
  let foregroundCalled = false;
  const clear = createLayeredHeaderClear({
    background: async () => { throw backgroundError; },
    foreground: async () => { foregroundCalled = true; },
    log: (message, level) => logs.push([message, level])
  });

  await assert.rejects(clear({ tft: true }), (error) => error === backgroundError);
  assert.equal(foregroundCalled, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /PostMessage down failed for TFT/);
  assert.match(logs[0][0], /no foreground click was attempted/);
  assert.equal(logs[0][1], 'warn');
});

test('layered header clear is a no-op without targets', async () => {
  let touched = false;
  const clear = createLayeredHeaderClear({
    background: async () => { touched = true; },
    foreground: async () => { touched = true; }
  });
  const result = await clear({});
  assert.deepEqual(result, { collection: false, tft: false, tftStore: false, mode: null });
  assert.equal(touched, false);
});
