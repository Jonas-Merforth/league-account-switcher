import { runPowerShell } from './powershell.js';

// League persists Collection/TFT acknowledgement through LCU preferences, but its already-running
// navigation plugin keeps the two parent pips in memory. Showing those header items is the only
// action the shipped plugin exposes that calls setItemAlert(false), so this is a deliberately narrow
// fallback after the API state has been updated. Ratios are relative to the League UX window and
// match the stable top navigation bar rather than screen pixels.
export const LEAGUE_HEADER_RATIOS = {
  league: { x: 0.2, y: 0.058 },
  tft: { x: 0.255, y: 0.058 },
  collection: { x: 0.592, y: 0.058 }
};

// TFT's top sub-navigation is stable in the installed 16.13 bundle. Event tabs are data-driven;
// only Store lacks a live VersionsSeen observer and therefore needs this source-gated visit.
export const TFT_SUBNAV_RATIOS = {
  store: { x: 0.3, y: 0.137 }
};

function ratioLiteral(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1) {
    throw new Error(`Invalid League header ratio: ${value}`);
  }
  return String(number);
}

export function buildLeagueHeaderClickScript({ collection = false, tft = false, tftStore = false } = {}) {
  const targets = [];
  if (collection) targets.push(['collection', LEAGUE_HEADER_RATIOS.collection]);
  if (tft || tftStore) targets.push(['TFT', LEAGUE_HEADER_RATIOS.tft]);
  if (tftStore) targets.push(['TFT Store', TFT_SUBNAV_RATIOS.store]);
  if (targets.length) targets.push(['League home', LEAGUE_HEADER_RATIOS.league]);
  const clicks = targets.map(([label, ratio]) =>
    `Invoke-HeaderClick ${ratioLiteral(ratio.x)} ${ratioLiteral(ratio.y)} '${label}'`
  ).join('\n');

  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class LeagueHeaderWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, UIntPtr extraInfo);
  public const int LEFTDOWN = 0x0002;
  public const int LEFTUP = 0x0004;
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
"@

$script:target = [IntPtr]::Zero
[LeagueHeaderWindow]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [LeagueHeaderWindow]::IsWindowVisible($hWnd)) { return $true }
  $procId = [uint32]0
  [void][LeagueHeaderWindow]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  $processName = ''
  try { $processName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  if ($processName -eq 'LeagueClientUx') {
    $title = [System.Text.StringBuilder]::new(256)
    [void][LeagueHeaderWindow]::GetWindowText($hWnd, $title, $title.Capacity)
    if ($title.ToString() -match 'League of Legends') {
      $script:target = $hWnd
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null

if ($script:target -eq [IntPtr]::Zero) { throw 'League client window not found.' }
$rect = [LeagueHeaderWindow+RECT]::new()
[void][LeagueHeaderWindow]::GetWindowRect($script:target, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 900 -or $height -lt 500) { throw "League client window is too small: $width x $height" }

$originalCursor = [LeagueHeaderWindow+POINT]::new()
[void][LeagueHeaderWindow]::GetCursorPos([ref]$originalCursor)
[void][LeagueHeaderWindow]::ShowWindow($script:target, 9)
[void][LeagueHeaderWindow]::SetForegroundWindow($script:target)
Start-Sleep -Milliseconds 120

function Invoke-HeaderClick([double]$xRatio, [double]$yRatio, [string]$label) {
  $x = [int]($rect.Left + $width * $xRatio)
  $y = [int]($rect.Top + $height * $yRatio)
  [void][LeagueHeaderWindow]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 40
  [LeagueHeaderWindow]::mouse_event([LeagueHeaderWindow]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
  [LeagueHeaderWindow]::mouse_event([LeagueHeaderWindow]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 450
  Write-Output ("clicked {0}" -f $label)
}

try {
${clicks ? clicks.split('\n').map((line) => `  ${line}`).join('\n') : "  Write-Output 'nothing to click'"}
} finally {
  [void][LeagueHeaderWindow]::SetCursorPos($originalCursor.X, $originalCursor.Y)
}
`;
}

export async function clearLeagueHeaderIndicators(targets) {
  if (!targets?.collection && !targets?.tft && !targets?.tftStore) {
    return { collection: false, tft: false, tftStore: false };
  }
  await runPowerShell(buildLeagueHeaderClickScript(targets), { timeoutMs: 8_000 });
  return {
    collection: Boolean(targets.collection),
    tft: Boolean(targets.tft || targets.tftStore),
    tftStore: Boolean(targets.tftStore)
  };
}
