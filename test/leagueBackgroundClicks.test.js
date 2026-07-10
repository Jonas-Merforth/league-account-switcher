import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBackgroundHeaderClickScript } from '../src/core/leagueBackgroundClicks.js';
import { createLayeredHeaderClear } from '../src/core/leagueHeaderClear.js';
import { LEAGUE_HEADER_RATIOS } from '../src/core/leagueHeaderClicks.js';

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
});

test('layered header clear prefers background and only falls back on failure', async () => {
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

test('layered header clear falls back to the foreground clicker and logs a warning', async () => {
  const logs = [];
  const clear = createLayeredHeaderClear({
    background: async () => { throw new Error('PostMessage down failed for TFT'); },
    foreground: async (targets) => ({ collection: Boolean(targets.collection), tft: Boolean(targets.tft) }),
    log: (message, level) => logs.push([message, level])
  });

  const result = await clear({ tft: true });
  assert.deepEqual(result, { collection: false, tft: true, mode: 'foreground' });
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /PostMessage down failed for TFT/);
  assert.equal(logs[0][1], 'warn');
});

test('layered header clear is a no-op without targets', async () => {
  let touched = false;
  const clear = createLayeredHeaderClear({
    background: async () => { touched = true; },
    foreground: async () => { touched = true; }
  });
  const result = await clear({});
  assert.deepEqual(result, { collection: false, tft: false, mode: null });
  assert.equal(touched, false);
});
