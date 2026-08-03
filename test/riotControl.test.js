import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_FIELD_RATIOS,
  backgroundStageFromDiagnostics,
  buildBackgroundPrefillScript,
  buildPrefillScript
} from '../src/core/riotControl.js';

test('buildPrefillScript refocuses the Riot login window during typing', () => {
  const script = buildPrefillScript(LOGIN_FIELD_RATIOS);

  assert.match(script, /function Focus-RiotWindow/);
  assert.match(script, /function Send-ToRiot/);
  assert.match(script, /function Paste-ToRiot/);
  assert.match(script, /Focus-RiotWindow\s+\[System\.Windows\.Forms\.SendKeys\]::SendWait\(\$keys\)/);
  assert.match(script, /if \(-not \$formReady\) \{ throw "Riot Client login form did not become ready/);
  assert.match(script, /\$windowAspect = if \(\$h -gt 0\)[\s\S]*\$looksLikeLogin = \$windowAspect -ge 1\.5 -and \$windowAspect -le 1\.95/);
  assert.doesNotMatch(script, /\$firstSeenH|\[Math\]::Abs\(\$h/);
  assert.equal(script.includes("[System.Windows.Forms.SendKeys]::SendWait('^v')"), false);
});

test('stay-signed-in fallbacks target the normal and Classic checkbox centers', () => {
  const point = (target) => ({
    x: Math.trunc(1536 * target.x),
    y: Math.trunc(864 * target.y)
  });

  assert.deepEqual(point(LOGIN_FIELD_RATIOS.staySignedInNormal), { x: 64, y: 434 });
  assert.deepEqual(point(LOGIN_FIELD_RATIOS.staySignedInClassic), { x: 64, y: 453 });
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
  assert.match(script, /foreach \(\$character in \$value\.ToCharArray\(\)\) \{\s+\$characterStartedAt = \$sw\.ElapsedMilliseconds\s+Focus-BackgroundField/);
  assert.match(script, /\$remaining = 72\s+while \(\$remaining -gt 0\)/);
  assert.match(script, /\$batch = \[Math\]::Min\(8, \$remaining\)/);
  assert.match(script, /\$formReady = \$false[\s\S]*if \(-not \$formReady\) \{ throw "Riot Client login form did not become ready/);
  assert.match(script, /\$topAspect = if \(\$topHeight -gt 0\)[\s\S]*\$looksLikeLogin = \$topAspect -ge 1\.5 -and \$topAspect -le 1\.95/);
  assert.doesNotMatch(script, /\$firstSeenHeight|\[Math\]::Abs\(\$topHeight/);
  assert.match(script, /\$cefDeadline = \(Get-Date\)\.AddSeconds\(8\)\s+while \(\(Get-Date\) -lt \$cefDeadline\)/);
  assert.match(script, /Chrome_RenderWidgetHostHWND/);
  assert.match(script, /\$script:largestCefArea = 0L/);
  assert.match(script, /if \(\$candidateArea -gt \$script:largestCefArea\)/);
  assert.match(script, /\$cefMatchesWindow = \$width -ge \[int\]\(\$topWidth \* 0\.7\) -and \$height -ge \[int\]\(\$topHeight \* 0\.7\)/);
  assert.match(script, /background CEF selected \{0\}x\{1\} from \{2\} candidate\(s\)/);
  assert.doesNotMatch(script, /\$script:cef = \$child\s+return \$false/);
  assert.match(script, /WM_CHAR = 0x0102/);
  assert.match(script, /WM_MOUSEMOVE = 0x0200/);
  assert.match(script, /SendMessage/);
  assert.doesNotMatch(script, /PostMessage/);
  assert.match(script, /Send-BackgroundText \$username/);
  assert.match(script, /Send-BackgroundText \$password/);
  assert.match(script, /background-prefilled/);
  assert.match(script, /SetForegroundWindow\(\$restoreHwnd\)/);
  assert.doesNotMatch(script, /SetCursorPos/);
  assert.doesNotMatch(script, /SendKeys/);
  assert.doesNotMatch(script, /Set-Clipboard/);
});

test('background prefill enables stay signed in before entering credentials', () => {
  const script = buildBackgroundPrefillScript(LOGIN_FIELD_RATIOS);
  const staySignedInAutomation = script.indexOf('if (Enable-StaySignedInWithAutomation)');
  const normalFallback = script.indexOf("Invoke-BackgroundClick 0.0417 0.5024 'stay-signed-in-normal-fallback'");
  const classicFallback = script.indexOf("Invoke-BackgroundClick 0.0417 0.5244 'stay-signed-in-classic-fallback'");
  const usernameClear = script.indexOf("Clear-BackgroundField 0.13 0.307 'username'");

  assert.notEqual(staySignedInAutomation, -1);
  assert.notEqual(normalFallback, -1);
  assert.notEqual(classicFallback, -1);
  assert.notEqual(usernameClear, -1);
  assert.ok(staySignedInAutomation < usernameClear);
  assert.ok(normalFallback < classicFallback);
  assert.ok(classicFallback < usernameClear);
  assert.match(script, /ControlTypeProperty[\s\S]*ControlType\]::CheckBox/);
  assert.match(script, /ToggleState -ne \[System\.Windows\.Automation\.ToggleState\]::On/);
  assert.match(script, /\$toggle\.Toggle\(\)/);
  assert.match(script, /function Invoke-BackgroundClick[\s\S]*SendMessage\(\$script:cef, \[RiotBackgroundLogin\]::WM_LBUTTONDOWN[\s\S]*SendMessage\(\$script:cef, \[RiotBackgroundLogin\]::WM_LBUTTONUP/);
  assert.doesNotMatch(script, /Invoke-BackgroundClick 0\.13 0\.307 'username'/);
  assert.doesNotMatch(script, /Invoke-BackgroundClick 0\.13 0\.384 'password'/);
});

test('background prefill restores focus only before input and reports phase timings', () => {
  const script = buildBackgroundPrefillScript(LOGIN_FIELD_RATIOS);
  const restore = script.indexOf('SetForegroundWindow($restoreHwnd)');
  const staySignedIn = script.indexOf('if (Enable-StaySignedInWithAutomation)');

  assert.notEqual(restore, -1);
  assert.ok(restore < staySignedIn);
  assert.match(script, /\$currentForeground -eq \$hwnd/);
  assert.match(script, /background phase \{0\}: \+\{1\}ms \(t=\{2\}ms\)/);
  assert.match(script, /Write-BackgroundPhase 'username-clear'/);
  assert.match(script, /Write-BackgroundPhase 'username-type'/);
  assert.match(script, /Write-BackgroundPhase 'password-clear'/);
  assert.match(script, /Write-BackgroundPhase 'password-type'/);
  assert.match(script, /syncMessages=\{3\}/);
  assert.match(script, /foregroundChanges=\{4\}/);
  assert.match(script, /Wait-MinimumInterval \$characterStartedAt 55\s+#[^\r\n]*\r?\n[^\r\n]*\r?\n\s+Start-Sleep -Milliseconds 10/);
  assert.match(script, /background-stage=\{0\}/);
});

test('partial background diagnostics preserve only completed credential stages', () => {
  assert.equal(backgroundStageFromDiagnostics('background phase form-ready: +1ms (t=1ms)'), '');
  assert.equal(backgroundStageFromDiagnostics('background phase stay-signed-in: +1ms (t=2ms)'), 'stay-signed-in');
  assert.equal(backgroundStageFromDiagnostics('background phase username-type: +1ms (t=3ms)'), 'username-complete');
  assert.equal(backgroundStageFromDiagnostics('background phase password-type: +1ms (t=4ms)'), 'password-complete');
  assert.equal(backgroundStageFromDiagnostics('background phase submit: +1ms (t=5ms)'), 'submitted');
});
