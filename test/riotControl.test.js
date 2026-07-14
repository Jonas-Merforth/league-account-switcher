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

test('background prefill reselects each field while editing so focus changes do not stop typing', () => {
  const script = buildBackgroundPrefillScript(LOGIN_FIELD_RATIOS);

  assert.match(script, /function Focus-BackgroundField/);
  assert.match(script, /Clear-BackgroundField 0\.13 0\.307 'username'/);
  assert.match(script, /Send-BackgroundText \$username 0\.13 0\.307 'username'/);
  assert.match(script, /Clear-BackgroundField 0\.13 0\.384 'password'/);
  assert.match(script, /Send-BackgroundText \$password 0\.13 0\.384 'password'/);
  assert.match(script, /foreach \(\$character in \$value\.ToCharArray\(\)\) \{\s+Focus-BackgroundField/);
  assert.match(script, /1\.\.64 \| ForEach-Object \{\s+Focus-BackgroundField/);
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

test('background prefill enables stay signed in before entering credentials', () => {
  const script = buildBackgroundPrefillScript(LOGIN_FIELD_RATIOS);
  const staySignedInClick = script.indexOf("Invoke-BackgroundClick 0.045 0.513 'stay-signed-in'");
  const usernameClick = script.indexOf("Invoke-BackgroundClick 0.13 0.307 'username'");

  assert.notEqual(staySignedInClick, -1);
  assert.notEqual(usernameClick, -1);
  assert.ok(staySignedInClick < usernameClick);
});
