import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_FIELD_RATIOS,
  buildBackgroundPrefillScript,
  buildPrefillScript
} from '../src/core/riotControl.js';

test('buildPrefillScript refocuses the Riot login window during typing', () => {
  const script = buildPrefillScript(LOGIN_FIELD_RATIOS);

  assert.match(script, /function Focus-RiotWindow/);
  assert.match(script, /function Send-ToRiot/);
  assert.match(script, /function Paste-ToRiot/);
  assert.match(script, /Focus-RiotWindow\s+\[System\.Windows\.Forms\.SendKeys\]::SendWait\(\$keys\)/);
  assert.equal(script.includes("[System.Windows.Forms.SendKeys]::SendWait('^v')"), false);
});

test('foreground retry can preserve the stay-signed-in state set by the background attempt', () => {
  const script = buildPrefillScript(LOGIN_FIELD_RATIOS, { clickStaySignedIn: false });

  assert.match(script, /kept stay-signed-in state from background attempt/);
  assert.doesNotMatch(script, /Invoke-Click .* 'stay-signed-in'/);
  assert.match(script, /Invoke-Click .* 'submit'/);
});

test('buildBackgroundPrefillScript posts mouse and character input without taking focus', () => {
  const script = buildBackgroundPrefillScript(LOGIN_FIELD_RATIOS);

  assert.match(script, /Chrome_RenderWidgetHostHWND/);
  assert.match(script, /WM_CHAR = 0x0102/);
  assert.match(script, /WM_MOUSEMOVE = 0x0200/);
  assert.match(script, /PostMessage/);
  assert.match(script, /SendMessage/);
  assert.match(script, /Send-BackgroundText \$username/);
  assert.match(script, /Send-BackgroundText \$password/);
  assert.match(script, /background-prefilled/);
  assert.doesNotMatch(script, /SetForegroundWindow/);
  assert.doesNotMatch(script, /SetCursorPos/);
  assert.doesNotMatch(script, /SendKeys/);
  assert.doesNotMatch(script, /Set-Clipboard/);
});
