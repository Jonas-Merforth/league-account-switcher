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

export function buildPrefillScript(ratios) {
  return `
$ErrorActionPreference = 'Stop'
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

if ($script:target -eq [IntPtr]::Zero) { throw 'Riot Client login window not found.' }

$rect = [RiotLoginWindow+RECT]::new()
[void][RiotLoginWindow]::GetWindowRect($script:target, [ref]$rect)
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
Write-Output ("window {0}x{1} at {2},{3}" -f $w, $h, $rect.Left, $rect.Top)
if ($w -lt 400 -or $h -lt 300) { throw "Riot Client window too small to click: $w x $h" }

[void][RiotLoginWindow]::ShowWindow($script:target, 9)
[void][RiotLoginWindow]::SetForegroundWindow($script:target)
Start-Sleep -Milliseconds 500

function Invoke-Click([double]$xr, [double]$yr, [string]$label) {
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

Invoke-Click ${ratios.username.x} ${ratios.username.y} 'username'
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 70
Set-Clipboard -Value $username
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 160

Invoke-Click ${ratios.password.x} ${ratios.password.y} 'password'
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 70
Set-Clipboard -Value $password
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 160

Invoke-Click ${ratios.staySignedIn.x} ${ratios.staySignedIn.y} 'stay-signed-in'
Start-Sleep -Milliseconds 120
Invoke-Click ${ratios.submit.x} ${ratios.submit.y} 'submit'
Start-Sleep -Milliseconds 150
Set-Clipboard -Value ' '
Write-Output 'prefilled'
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
export async function prefillRiotLogin({ username, password }) {
  const userB64 = Buffer.from(String(username ?? ''), 'utf8').toString('base64');
  const passB64 = Buffer.from(String(password ?? ''), 'utf8').toString('base64');
  const out = await runPowerShell(buildPrefillScript(LOGIN_FIELD_RATIOS), {
    input: `${userB64} ${passB64}`,
    timeoutMs: 20000
  });
  // Return the script's diagnostics (window rect + click points) so the caller can log them.
  return String(out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' | ');
}
