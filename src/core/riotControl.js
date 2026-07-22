import { spawn } from 'node:child_process';
import { RIOT_LAUNCH_ARGS, RIOT_PROCESS_IMAGES } from './constants.js';
import { runPowerShell } from './powershell.js';

// Windows control surface for the account switch: force-close the Riot/League processes, relaunch
// the Riot Client, and (only when there is no usable saved session) prefill the real login form.
// All PowerShell, mirroring the spawn pattern in clicker.js. No third-party dependencies.

function toPowerShellArray(values) {
  // Builds a PS string-array literal from our own constant (no external input), e.g. @('a.exe','b.exe').
  return `@(${values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(', ')})`;
}

function buildKillScript(images) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$images = ${toPowerShellArray(images)}
foreach ($img in $images) { taskkill /F /IM $img 2>$null | Out-Null }
$deadline = (Get-Date).AddSeconds(10)
do {
  $alive = $false
  foreach ($img in $images) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($img)
    if (Get-Process -Name $name -ErrorAction SilentlyContinue) { $alive = $true; break }
  }
  if (-not $alive) { break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
Write-Output 'killed'
`;
}

// The login window is a CEF/Chromium web view: no field is focused on load, so each field must be
// CLICKED before pasting. Coordinates are window-relative ratios (logged to stdout so they can be
// tuned from a real run). Clipboard paste keeps passwords with SendKeys-special chars intact.
// Field-position ratios derived from the Riot Client login layout (left panel).
export const LOGIN_FIELD_RATIOS = {
  username: { x: 0.13, y: 0.307 },
  password: { x: 0.13, y: 0.384 },
  staySignedIn: { x: 0.045, y: 0.513 },
  submit: { x: 0.13, y: 0.809 }
};

export function buildBackgroundPrefillScript(ratios) {
  return `
$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RiotBackgroundLogin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public const uint WM_KEYDOWN = 0x0100;
  public const uint WM_KEYUP = 0x0101;
  public const uint WM_CHAR = 0x0102;
  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const int VK_BACK = 0x08;
  public const int VK_END = 0x23;
  public const int MK_LBUTTON = 0x0001;
  public const int SW_SHOWNOACTIVATE = 4;
  public const int SW_SHOWMINNOACTIVE = 7;
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$parts = [Console]::In.ReadToEnd().Trim().Split(' ')
$username = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[0]))
$password = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
$restoreWindowValue = 0L
if ($parts.Length -ge 3) { [void][long]::TryParse($parts[2], [ref]$restoreWindowValue) }
$script:lastPhaseMs = 0L
$script:syncMessageCount = 0

function Write-BackgroundPhase([string]$name) {
  $elapsed = $sw.ElapsedMilliseconds
  Write-Output ("background phase {0}: +{1}ms (t={2}ms)" -f $name, ($elapsed - $script:lastPhaseMs), $elapsed)
  $script:lastPhaseMs = $elapsed
}

function Wait-MinimumInterval([long]$startedAtMs, [int]$minimumMs) {
  $remaining = $minimumMs - ($sw.ElapsedMilliseconds - $startedAtMs)
  if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
}

function Find-RiotWindow {
  $script:target = [IntPtr]::Zero
  [RiotBackgroundLogin]::EnumWindows({
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [RiotBackgroundLogin]::IsWindowVisible($hWnd)) { return $true }
    $titleText = [System.Text.StringBuilder]::new(256)
    [void][RiotBackgroundLogin]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
    $procId = [uint32]0
    [void][RiotBackgroundLogin]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    $processName = ''
    try { $processName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    if (($titleText.ToString() -match 'Riot Client' -or $processName -match '^RiotClientUx') -and $titleText.ToString() -notmatch 'Automation') {
      $script:target = $hWnd
      return $false
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  return $script:target
}

# Wait for the intro window to be replaced by the full login form, matching the foreground path.
$deadline = (Get-Date).AddSeconds(15)
$hwnd = [IntPtr]::Zero
$topRect = [RiotBackgroundLogin+RECT]::new()
$topWidth = 0; $topHeight = 0; $firstSeenHeight = 0
$formReady = $false
while ($true) {
  $hwnd = Find-RiotWindow
  if ($hwnd -ne [IntPtr]::Zero) {
    [void][RiotBackgroundLogin]::GetWindowRect($hwnd, [ref]$topRect)
    $topWidth = $topRect.Right - $topRect.Left
    $topHeight = $topRect.Bottom - $topRect.Top
    if ($firstSeenHeight -eq 0 -and $topHeight -gt 0) { $firstSeenHeight = $topHeight }
    # The measured intro is 1300x600 (~2.17:1); the login form is 1536x864 (~1.78:1).
    # Aspect ratio positively identifies an already-rendered form even when DPI scaling puts it
    # below 700px and this script did not witness the intro-to-form resize.
    $looksLikeLogin = $topHeight -gt 0 -and (($topWidth / [double]$topHeight) -le 1.95)
    if ($looksLikeLogin -or ($firstSeenHeight -gt 0 -and [Math]::Abs($topHeight - $firstSeenHeight) -gt 50)) {
      $formReady = $true
      break
    }
  }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 250
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'Riot Client login window not found.' }
if (-not $formReady) { throw "Riot Client login form did not become ready (last window: $topWidth x $topHeight)." }
if ($topWidth -lt 400 -or $topHeight -lt 300) { throw "Riot Client window too small to type into: $topWidth x $topHeight" }
Write-BackgroundPhase 'form-ready'

$wasMinimized = [RiotBackgroundLogin]::IsIconic($hwnd)
if ($wasMinimized) {
  [void][RiotBackgroundLogin]::ShowWindow($hwnd, [RiotBackgroundLogin]::SW_SHOWNOACTIVATE)
  Start-Sleep -Milliseconds 500
}

try {
  $script:backgroundStage = 'readiness'
  $width = 0; $height = 0
  $cefDeadline = (Get-Date).AddSeconds(8)
  while ((Get-Date) -lt $cefDeadline) {
    $script:cef = [IntPtr]::Zero
    [RiotBackgroundLogin]::EnumChildWindows($hwnd, {
      param([IntPtr]$child, [IntPtr]$lParam)
      $className = [System.Text.StringBuilder]::new(256)
      [void][RiotBackgroundLogin]::GetClassName($child, $className, $className.Capacity)
      if ($className.ToString() -eq 'Chrome_RenderWidgetHostHWND') {
        $script:cef = $child
        return $false
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    if ($script:cef -ne [IntPtr]::Zero) {
      $cefRect = [RiotBackgroundLogin+RECT]::new()
      [void][RiotBackgroundLogin]::GetClientRect($script:cef, [ref]$cefRect)
      $width = $cefRect.Right - $cefRect.Left
      $height = $cefRect.Bottom - $cefRect.Top
      if ($width -ge 400 -and $height -ge 300) { break }
    }
    Start-Sleep -Milliseconds 250
  }
  if ($script:cef -eq [IntPtr]::Zero) { throw 'Riot Client CEF input window not found.' }
  if ($width -lt 400 -or $height -lt 300) { throw "Riot Client CEF window too small to type into: $width x $height" }
  Write-BackgroundPhase 'cef-ready'

  # Riot normally brings itself forward while launching. Restore the switcher's window only when it
  # was the pre-launch foreground window and Riot still owns the foreground now. If the user already
  # chose another app, leave their newer choice alone. This happens before every login-form edit.
  $foregroundState = 'unchanged'
  if ($restoreWindowValue -gt 0) {
    $restoreHwnd = [IntPtr]::new($restoreWindowValue)
    $currentForeground = [RiotBackgroundLogin]::GetForegroundWindow()
    if ($currentForeground -eq $hwnd -and [RiotBackgroundLogin]::IsWindow($restoreHwnd) -and [RiotBackgroundLogin]::IsWindowVisible($restoreHwnd)) {
      $foregroundState = if ([RiotBackgroundLogin]::SetForegroundWindow($restoreHwnd)) { 'restored' } else { 'restore-rejected' }
      Start-Sleep -Milliseconds 80
    } elseif ($currentForeground -ne $hwnd) {
      $foregroundState = 'user-selected-other-window'
    }
  }
  Write-Output ("background foreground state: {0}" -f $foregroundState)
  Write-BackgroundPhase 'foreground-settled'
  $script:lastObservedForeground = [RiotBackgroundLogin]::GetForegroundWindow()
  $script:foregroundChangeCount = 0

  function Post-RiotMessage([uint32]$message, [IntPtr]$wParam, [IntPtr]$lParam, [string]$label) {
    if (-not [RiotBackgroundLogin]::PostMessage($script:cef, $message, $wParam, $lParam)) {
      throw "PostMessage failed for $label"
    }
  }

  function Invoke-BackgroundClick([double]$xRatio, [double]$yRatio, [string]$label) {
    $x = [int]($width * $xRatio)
    $y = [int]($height * $yRatio)
    $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    Post-RiotMessage ([RiotBackgroundLogin]::WM_MOUSEMOVE) ([IntPtr]::Zero) $lp "$label move"
    Start-Sleep -Milliseconds 60
    Post-RiotMessage ([RiotBackgroundLogin]::WM_LBUTTONDOWN) ([IntPtr][RiotBackgroundLogin]::MK_LBUTTON) $lp "$label down"
    Start-Sleep -Milliseconds 40
    Post-RiotMessage ([RiotBackgroundLogin]::WM_LBUTTONUP) ([IntPtr]::Zero) $lp "$label up"
    Start-Sleep -Milliseconds 160
    Write-Output ("background click {0} at {1},{2}" -f $label, $x, $y)
  }

  function Invoke-BackgroundKey([int]$virtualKey, [string]$label) {
    # SendMessage is synchronous at the CEF host window, avoiding the burst loss seen when a whole
    # field was queued through PostMessage before Chromium had forwarded earlier input to JS.
    $startedAt = $sw.ElapsedMilliseconds
    [void][RiotBackgroundLogin]::SendMessage($script:cef, [RiotBackgroundLogin]::WM_KEYDOWN, [IntPtr]$virtualKey, [IntPtr]1)
    [void][RiotBackgroundLogin]::SendMessage($script:cef, [RiotBackgroundLogin]::WM_KEYUP, [IntPtr]$virtualKey, [IntPtr]::Zero)
    $script:syncMessageCount += 2
    Wait-MinimumInterval $startedAt 5
  }

  function Focus-BackgroundField([double]$xRatio, [double]$yRatio, [string]$label) {
    # A real click into another window makes Chromium blur the login field even though direct
    # WM_CHAR messages still reach its host HWND. Re-click the intended field synchronously before
    # every edit so changing apps during the background prefill cannot redirect or drop characters.
    $startedAt = $sw.ElapsedMilliseconds
    $observedForeground = [RiotBackgroundLogin]::GetForegroundWindow()
    if ($observedForeground -ne $script:lastObservedForeground) {
      $script:foregroundChangeCount += 1
      $script:lastObservedForeground = $observedForeground
    }
    $x = [int]($width * $xRatio)
    $y = [int]($height * $yRatio)
    $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    [void][RiotBackgroundLogin]::SendMessage($script:cef, [RiotBackgroundLogin]::WM_MOUSEMOVE, [IntPtr]::Zero, $lp)
    [void][RiotBackgroundLogin]::SendMessage($script:cef, [RiotBackgroundLogin]::WM_LBUTTONDOWN, [IntPtr][RiotBackgroundLogin]::MK_LBUTTON, $lp)
    [void][RiotBackgroundLogin]::SendMessage($script:cef, [RiotBackgroundLogin]::WM_LBUTTONUP, [IntPtr]::Zero, $lp)
    $script:syncMessageCount += 3
    Wait-MinimumInterval $startedAt 5
  }

  function Clear-BackgroundField([double]$xRatio, [double]$yRatio, [string]$label) {
    # The cleared session normally produces empty fields. VK_END + backspaces also handles a
    # remembered username without relying on a synthetic Ctrl modifier or the system clipboard.
    # Reacquire in small batches. Seventy-two backspaces include one full lost-batch allowance, but
    # repeating the three-message click and End key before every single backspace made a blank form
    # take seconds to clear. An eight-key batch lets later batches recover from a focus change.
    $remaining = 72
    while ($remaining -gt 0) {
      Focus-BackgroundField $xRatio $yRatio $label
      Invoke-BackgroundKey ([RiotBackgroundLogin]::VK_END) "$label end"
      $batch = [Math]::Min(8, $remaining)
      1..$batch | ForEach-Object { Invoke-BackgroundKey ([RiotBackgroundLogin]::VK_BACK) "$label clear" }
      $remaining -= $batch
    }
    Start-Sleep -Milliseconds 40
  }

  function Send-BackgroundText([string]$value, [double]$xRatio, [double]$yRatio, [string]$label) {
    foreach ($character in $value.ToCharArray()) {
      $characterStartedAt = $sw.ElapsedMilliseconds
      Focus-BackgroundField $xRatio $yRatio $label
      Invoke-BackgroundKey ([RiotBackgroundLogin]::VK_END) "$label end"
      [void][RiotBackgroundLogin]::SendMessage($script:cef, [RiotBackgroundLogin]::WM_CHAR, [IntPtr][int]$character, [IntPtr]1)
      $script:syncMessageCount += 1
      # The synchronous CEF work counts toward this pacing budget. Fast systems still get a safe
      # minimum interval, while slower systems no longer pay the old fixed 45ms on top of all work.
      Wait-MinimumInterval $characterStartedAt 55
      # Always leave Chromium a small post-character dwell. On a slow host, synchronous focus/input
      # work can consume the whole pacing budget; without this, the next refocus can begin instantly.
      Start-Sleep -Milliseconds 10
    }
    Write-Output ("background typed {0} characters into {1}" -f $value.Length, $label)
  }

  # Enable persistence first. If credential entry needs the foreground safety retry, it can preserve
  # this state even when the original background typing was interrupted partway through.
  Invoke-BackgroundClick ${ratios.staySignedIn.x} ${ratios.staySignedIn.y} 'stay-signed-in'
  $script:backgroundStage = 'stay-signed-in'
  Write-BackgroundPhase 'stay-signed-in'

  Clear-BackgroundField ${ratios.username.x} ${ratios.username.y} 'username'
  Write-BackgroundPhase 'username-clear'
  Send-BackgroundText $username ${ratios.username.x} ${ratios.username.y} 'username'
  $script:backgroundStage = 'username-complete'
  Write-BackgroundPhase 'username-type'
  Start-Sleep -Milliseconds 60

  Clear-BackgroundField ${ratios.password.x} ${ratios.password.y} 'password'
  Write-BackgroundPhase 'password-clear'
  Send-BackgroundText $password ${ratios.password.x} ${ratios.password.y} 'password'
  $script:backgroundStage = 'password-complete'
  Write-BackgroundPhase 'password-type'
  Start-Sleep -Milliseconds 100

  Invoke-BackgroundClick ${ratios.submit.x} ${ratios.submit.y} 'submit'
  $script:backgroundStage = 'submitted'
  Write-BackgroundPhase 'submit'
  Write-Output ("background-prefilled (t={0}ms, cef={1}x{2}, syncMessages={3}, foregroundChanges={4})" -f $sw.ElapsedMilliseconds, $width, $height, $script:syncMessageCount, $script:foregroundChangeCount)
} catch {
  throw ("background-stage={0}: {1}" -f $script:backgroundStage, $_.Exception.Message)
} finally {
  if ($wasMinimized) {
    [void][RiotBackgroundLogin]::ShowWindow($hwnd, [RiotBackgroundLogin]::SW_SHOWMINNOACTIVE)
  }
}
`;
}

export function buildPrefillScript(ratios, { clickStaySignedIn = true } = {}) {
  return `
$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RiotLoginWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, UIntPtr extraInfo);
  public const int LEFTDOWN = 0x0002;
  public const int LEFTUP = 0x0004;
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$parts = [Console]::In.ReadToEnd().Trim().Split(' ')
$username = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[0]))
$password = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))

function Find-RiotWindow {
  $script:target = [IntPtr]::Zero
  [RiotLoginWindow]::EnumWindows({
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [RiotLoginWindow]::IsWindowVisible($hWnd)) { return $true }
    $sb = [System.Text.StringBuilder]::new(256)
    [void][RiotLoginWindow]::GetWindowText($hWnd, $sb, $sb.Capacity)
    $title = $sb.ToString()
    $procId = [uint32]0
    [void][RiotLoginWindow]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    $pname = ''
    try { $pname = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
    if (($title -match 'Riot Client' -or $pname -match '^RiotClientUx') -and $title -notmatch 'Automation') {
      $script:target = $hWnd
      return $false
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  return $script:target
}

# The client plays a Riot Games intro animation in a smaller window (1300x600 measured here) before
# the login form renders in the full-size window (1536x864); clicks and keystrokes during the
# animation are lost (a real run typed only the password because the username went to the
# animation). Poll until the window has the login form's aspect ratio or resizes away from the intro
# size. Never type after the deadline without positive readiness: the intro accepts input but
# silently loses the username.
$deadline = (Get-Date).AddSeconds(15)
$hwnd = [IntPtr]::Zero
$rect = [RiotLoginWindow+RECT]::new()
$w = 0; $h = 0; $firstSeenH = 0
$formReady = $false
while ($true) {
  $hwnd = Find-RiotWindow
  if ($hwnd -ne [IntPtr]::Zero) {
    [void][RiotLoginWindow]::GetWindowRect($hwnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($firstSeenH -eq 0 -and $h -gt 0) { $firstSeenH = $h }
    $looksLikeLogin = $h -gt 0 -and (($w / [double]$h) -le 1.95)
    if ($looksLikeLogin -or ($firstSeenH -gt 0 -and [Math]::Abs($h - $firstSeenH) -gt 50)) {
      $formReady = $true
      break
    }
  }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 250
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'Riot Client login window not found.' }
if (-not $formReady) { throw "Riot Client login form did not become ready (last window: $w x $h)." }
Write-Output ("window {0}x{1} at {2},{3} (form-ready t={4}ms)" -f $w, $h, $rect.Left, $rect.Top, $sw.ElapsedMilliseconds)
if ($w -lt 400 -or $h -lt 300) { throw "Riot Client window too small to click: $w x $h" }

[void][RiotLoginWindow]::ShowWindow($hwnd, 9)
[void][RiotLoginWindow]::SetForegroundWindow($hwnd)
# Let the form finish fading in, then re-read the rect: the click coordinates must come from the
# login-sized window, not the splash rect the wait loop may have captured last.
Start-Sleep -Milliseconds 1000
[void][RiotLoginWindow]::GetWindowRect($hwnd, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top

function Focus-RiotWindow {
  [void][RiotLoginWindow]::ShowWindow($hwnd, 9)
  [void][RiotLoginWindow]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 80
}

function Invoke-Click([double]$xr, [double]$yr, [string]$label) {
  Focus-RiotWindow
  $x = [int]($rect.Left + $w * $xr)
  $y = [int]($rect.Top + $h * $yr)
  [void][RiotLoginWindow]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 90
  [RiotLoginWindow]::mouse_event([RiotLoginWindow]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [RiotLoginWindow]::mouse_event([RiotLoginWindow]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 160
  Write-Output ("click {0} at {1},{2}" -f $label, $x, $y)
}

function Send-ToRiot([string]$keys) {
  Focus-RiotWindow
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}

function Paste-ToRiot([string]$value) {
  Focus-RiotWindow
  Set-Clipboard -Value $value
  Start-Sleep -Milliseconds 70
  Send-ToRiot '^v'
}

Invoke-Click ${ratios.username.x} ${ratios.username.y} 'username'
Send-ToRiot '^a'
Start-Sleep -Milliseconds 70
Paste-ToRiot $username
Start-Sleep -Milliseconds 160

Invoke-Click ${ratios.password.x} ${ratios.password.y} 'password'
Send-ToRiot '^a'
Start-Sleep -Milliseconds 70
Paste-ToRiot $password
Start-Sleep -Milliseconds 160

${clickStaySignedIn ? `Invoke-Click ${ratios.staySignedIn.x} ${ratios.staySignedIn.y} 'stay-signed-in'
Start-Sleep -Milliseconds 120` : "Write-Output 'kept stay-signed-in state from background attempt'"}
Invoke-Click ${ratios.submit.x} ${ratios.submit.y} 'submit'
Start-Sleep -Milliseconds 150
Set-Clipboard -Value ' '
Write-Output ("prefilled (t={0}ms)" -f $sw.ElapsedMilliseconds)
`;
}

// Force-close all Riot/League processes and wait until they are gone.
export async function killRiotAndLeague() {
  await runPowerShell(buildKillScript(RIOT_PROCESS_IMAGES), { timeoutMs: 15000 });
}

// Path-independent "is League up?" check: true if the League client UI or game process is running.
// Used as a fallback when League's lockfile isn't found at the configured/auto-detected path.
export async function isLeagueRunning() {
  const script = "if (Get-Process -Name 'LeagueClientUx','League of Legends' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }";
  const out = await runPowerShell(script, { timeoutMs: 5000 });
  return /yes/.test(out);
}

// Launch the Riot Client; with a valid session in place it signs in and boots League automatically.
// Resolves once the process has spawned and rejects on a spawn failure (e.g. a stale/wrong
// RiotClientServices path) — an unhandled 'error' event here would crash the whole app.
export function launchRiotClient(servicesPath, args = RIOT_LAUNCH_ARGS) {
  return new Promise((resolve, reject) => {
    const child = spawn(servicesPath, args, { detached: true, stdio: 'ignore' });
    child.once('error', (error) => {
      reject(new Error(`Could not launch the Riot Client (${servicesPath}): ${error.message}`));
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

// Prefill the Riot Client login form with the given credentials and submit. Used only as the
// fallback when no usable saved session exists; passive hCaptcha behaves as it does for a manual
// login. Credentials cross to PowerShell as base64 on stdin, never as command-line arguments.
export function backgroundStageFromDiagnostics(output) {
  const phases = [...String(output ?? '').matchAll(/background phase ([a-z-]+):/gi)];
  const lastPhase = phases.at(-1)?.[1]?.toLowerCase() ?? '';
  if (lastPhase === 'submit') return 'submitted';
  if (lastPhase === 'password-type') return 'password-complete';
  if (lastPhase === 'password-clear' || lastPhase === 'username-type') return 'username-complete';
  if (lastPhase === 'username-clear' || lastPhase === 'stay-signed-in') return 'stay-signed-in';
  return '';
}

export async function prefillRiotLogin({
  username,
  password,
  mode = 'background',
  clickStaySignedIn = true,
  restoreWindowHandle = '0'
}) {
  const userB64 = Buffer.from(String(username ?? ''), 'utf8').toString('base64');
  const passB64 = Buffer.from(String(password ?? ''), 'utf8').toString('base64');
  const restoreHandle = /^\d+$/.test(String(restoreWindowHandle ?? ''))
    ? String(restoreWindowHandle)
    : '0';
  const script = mode === 'foreground'
    ? buildPrefillScript(LOGIN_FIELD_RATIOS, { clickStaySignedIn })
    : buildBackgroundPrefillScript(LOGIN_FIELD_RATIOS);
  let out;
  try {
    out = await runPowerShell(script, {
      // Background readiness can spend 15s on the full form and another 8s on its CEF input child.
      // Leave room for robust paced typing after both deadlines on a slower machine.
      input: `${userB64} ${passB64} ${restoreHandle}`,
      timeoutMs: 45000,
      capturePartialStdout: mode === 'background'
    });
  } catch (error) {
    if (mode === 'background') {
      if (!/background-stage=/i.test(String(error?.message ?? ''))) {
        const completedStage = backgroundStageFromDiagnostics(error?.partialStdout);
        if (completedStage) error.message = `background-stage=${completedStage}: ${error.message}`;
      }
      if (Object.hasOwn(error, 'partialStdout')) delete error.partialStdout;
    }
    throw error;
  }
  // Return the script's diagnostics (window rect + click points) so the caller can log them.
  return String(out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' | ');
}
