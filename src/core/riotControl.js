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
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
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
while ($true) {
  $hwnd = Find-RiotWindow
  if ($hwnd -ne [IntPtr]::Zero) {
    [void][RiotBackgroundLogin]::GetWindowRect($hwnd, [ref]$topRect)
    $topWidth = $topRect.Right - $topRect.Left
    $topHeight = $topRect.Bottom - $topRect.Top
    if ($firstSeenHeight -eq 0 -and $topHeight -gt 0) { $firstSeenHeight = $topHeight }
    if ($topHeight -ge 700 -or ($firstSeenHeight -gt 0 -and [Math]::Abs($topHeight - $firstSeenHeight) -gt 50)) { break }
  }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 250
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'Riot Client login window not found.' }
if ($topWidth -lt 400 -or $topHeight -lt 300) { throw "Riot Client window too small to type into: $topWidth x $topHeight" }

$wasMinimized = [RiotBackgroundLogin]::IsIconic($hwnd)
if ($wasMinimized) {
  [void][RiotBackgroundLogin]::ShowWindow($hwnd, [RiotBackgroundLogin]::SW_SHOWNOACTIVATE)
  Start-Sleep -Milliseconds 500
}

try {
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
  if ($script:cef -eq [IntPtr]::Zero) { throw 'Riot Client CEF input window not found.' }

  $cefRect = [RiotBackgroundLogin+RECT]::new()
  [void][RiotBackgroundLogin]::GetClientRect($script:cef, [ref]$cefRect)
  $width = $cefRect.Right - $cefRect.Left
  $height = $cefRect.Bottom - $cefRect.Top
  if ($width -lt 400 -or $height -lt 300) { throw "Riot Client CEF window too small to type into: $width x $height" }

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
    [void][RiotBackgroundLogin]::SendMessage($script:cef, [RiotBackgroundLogin]::WM_KEYDOWN, [IntPtr]$virtualKey, [IntPtr]1)
    [void][RiotBackgroundLogin]::SendMessage($script:cef, [RiotBackgroundLogin]::WM_KEYUP, [IntPtr]$virtualKey, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 5
  }

  function Clear-BackgroundField([string]$label) {
    # The cleared session normally produces empty fields. VK_END + backspaces also handles a
    # remembered username without relying on a synthetic Ctrl modifier or the system clipboard.
    Invoke-BackgroundKey ([RiotBackgroundLogin]::VK_END) "$label end"
    1..64 | ForEach-Object { Invoke-BackgroundKey ([RiotBackgroundLogin]::VK_BACK) "$label clear" }
    Start-Sleep -Milliseconds 120
  }

  function Send-BackgroundText([string]$value, [string]$label) {
    foreach ($character in $value.ToCharArray()) {
      [void][RiotBackgroundLogin]::SendMessage($script:cef, [RiotBackgroundLogin]::WM_CHAR, [IntPtr][int]$character, [IntPtr]1)
      Start-Sleep -Milliseconds 45
    }
    Write-Output ("background typed {0} characters into {1}" -f $value.Length, $label)
  }

  Invoke-BackgroundClick ${ratios.username.x} ${ratios.username.y} 'username'
  Clear-BackgroundField 'username'
  Send-BackgroundText $username 'username'
  Start-Sleep -Milliseconds 180

  Invoke-BackgroundClick ${ratios.password.x} ${ratios.password.y} 'password'
  Clear-BackgroundField 'password'
  Send-BackgroundText $password 'password'
  Start-Sleep -Milliseconds 180

  Invoke-BackgroundClick ${ratios.staySignedIn.x} ${ratios.staySignedIn.y} 'stay-signed-in'
  Start-Sleep -Milliseconds 120
  Invoke-BackgroundClick ${ratios.submit.x} ${ratios.submit.y} 'submit'
  Write-Output ("background-prefilled (t={0}ms, cef={1}x{2})" -f $sw.ElapsedMilliseconds, $width, $height)
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
# animation). Poll until the window is login-sized — or, for machines whose login window is smaller
# than the threshold, until it resizes away from the size it was first seen at — with a deadline so
# an unrecognized layout still gets a best-effort attempt instead of hanging.
$deadline = (Get-Date).AddSeconds(15)
$hwnd = [IntPtr]::Zero
$rect = [RiotLoginWindow+RECT]::new()
$w = 0; $h = 0; $firstSeenH = 0
while ($true) {
  $hwnd = Find-RiotWindow
  if ($hwnd -ne [IntPtr]::Zero) {
    [void][RiotLoginWindow]::GetWindowRect($hwnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($firstSeenH -eq 0 -and $h -gt 0) { $firstSeenH = $h }
    if ($h -ge 700 -or ($firstSeenH -gt 0 -and [Math]::Abs($h - $firstSeenH) -gt 50)) { break }
  }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 250
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'Riot Client login window not found.' }
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
export async function prefillRiotLogin({ username, password, mode = 'background', clickStaySignedIn = true }) {
  const userB64 = Buffer.from(String(username ?? ''), 'utf8').toString('base64');
  const passB64 = Buffer.from(String(password ?? ''), 'utf8').toString('base64');
  const script = mode === 'foreground'
    ? buildPrefillScript(LOGIN_FIELD_RATIOS, { clickStaySignedIn })
    : buildBackgroundPrefillScript(LOGIN_FIELD_RATIOS);
  const out = await runPowerShell(script, {
    // Generous: the script itself may wait up to ~15s for the login form to replace the intro
    // animation before it starts clicking.
    input: `${userB64} ${passB64}`,
    timeoutMs: 35000
  });
  // Return the script's diagnostics (window rect + click points) so the caller can log them.
  return String(out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' | ');
}
