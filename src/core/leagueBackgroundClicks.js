import { runPowerShell } from './powershell.js';
import { LEAGUE_HEADER_RATIOS, TFT_SUBNAV_RATIOS } from './leagueHeaderClicks.js';

// Background variant of the League header fallback: posts window messages straight to the
// client's CEF input window (Chrome_RenderWidgetHostHWND) instead of foregrounding the client
// and synthesizing real cursor input. The client keeps its z-order and focus, the cursor never
// moves, and a minimized client is restored without activation and re-minimized afterwards.
// The visible page still navigates (that in-process navigation is the only thing that clears
// the cached header pips), so callers should still end on the League home target.

function ratioLiteral(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1) {
    throw new Error(`Invalid League header ratio: ${value}`);
  }
  return String(number);
}

export function buildBackgroundHeaderClickScript({ collection = false, tft = false, tftStore = false } = {}) {
  const targets = [];
  if (collection) targets.push(['collection', LEAGUE_HEADER_RATIOS.collection]);
  if (tft || tftStore) targets.push(['TFT', LEAGUE_HEADER_RATIOS.tft]);
  if (tftStore) targets.push(['TFT Store', TFT_SUBNAV_RATIOS.store]);
  if (targets.length) targets.push(['League home', LEAGUE_HEADER_RATIOS.league]);
  const clicks = targets.map(([label, ratio]) =>
    `Invoke-BackgroundClick ${ratioLiteral(ratio.x)} ${ratioLiteral(ratio.y)} '${label}'`
  ).join('\n');

  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class LeagueBgClick {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const int MK_LBUTTON = 0x0001;
  public const int SW_SHOWNOACTIVATE = 4;
  public const int SW_SHOWMINNOACTIVE = 7;
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$script:target = [IntPtr]::Zero
[LeagueBgClick]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [LeagueBgClick]::IsWindowVisible($hWnd)) { return $true }
  $procId = [uint32]0
  [void][LeagueBgClick]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  $processName = ''
  try { $processName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  if ($processName -eq 'LeagueClientUx') {
    $title = [System.Text.StringBuilder]::new(256)
    [void][LeagueBgClick]::GetWindowText($hWnd, $title, $title.Capacity)
    if ($title.ToString() -match 'League of Legends') {
      $script:target = $hWnd
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null

if ($script:target -eq [IntPtr]::Zero) { throw 'League client window not found.' }

$wasMinimized = $false
if ([LeagueBgClick]::IsIconic($script:target)) {
  # Restore without activation so CEF lays the page out again; posted clicks are unreliable
  # against an iconic window. SW_SHOWNOACTIVATE keeps focus where it is.
  [void][LeagueBgClick]::ShowWindow($script:target, [LeagueBgClick]::SW_SHOWNOACTIVATE)
  $wasMinimized = $true
  Start-Sleep -Milliseconds 400
}

try {
  $script:cef = [IntPtr]::Zero
  [LeagueBgClick]::EnumChildWindows($script:target, {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $className = [System.Text.StringBuilder]::new(256)
    [void][LeagueBgClick]::GetClassName($hWnd, $className, $className.Capacity)
    if ($className.ToString() -eq 'Chrome_RenderWidgetHostHWND') {
      $script:cef = $hWnd
      return $false
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($script:cef -eq [IntPtr]::Zero) { throw 'League CEF input window not found.' }

  $rect = [LeagueBgClick+RECT]::new()
  [void][LeagueBgClick]::GetClientRect($script:cef, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 900 -or $height -lt 500) { throw "League client window is too small: $width x $height" }

  function Invoke-BackgroundClick([double]$xRatio, [double]$yRatio, [string]$label) {
    $x = [int]($width * $xRatio)
    $y = [int]($height * $yRatio)
    $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    # CEF resolves the click target from its last hover position, so move first.
    if (-not [LeagueBgClick]::PostMessage($script:cef, [LeagueBgClick]::WM_MOUSEMOVE, [IntPtr]::Zero, $lp)) { throw "PostMessage move failed for $label" }
    Start-Sleep -Milliseconds 60
    if (-not [LeagueBgClick]::PostMessage($script:cef, [LeagueBgClick]::WM_LBUTTONDOWN, [IntPtr][LeagueBgClick]::MK_LBUTTON, $lp)) { throw "PostMessage down failed for $label" }
    Start-Sleep -Milliseconds 40
    if (-not [LeagueBgClick]::PostMessage($script:cef, [LeagueBgClick]::WM_LBUTTONUP, [IntPtr]::Zero, $lp)) { throw "PostMessage up failed for $label" }
    Start-Sleep -Milliseconds 450
    Write-Output ("clicked-bg {0}" -f $label)
  }

${clicks ? clicks.split('\n').map((line) => `  ${line}`).join('\n') : "  Write-Output 'nothing to click'"}
  Write-Output 'background-clicks-ok'
} finally {
  if ($wasMinimized) {
    [void][LeagueBgClick]::ShowWindow($script:target, [LeagueBgClick]::SW_SHOWMINNOACTIVE)
  }
}
`;
}

export async function clearLeagueHeaderIndicatorsBackground(targets) {
  if (!targets?.collection && !targets?.tft && !targets?.tftStore) {
    return { collection: false, tft: false, tftStore: false };
  }
  const stdout = await runPowerShell(buildBackgroundHeaderClickScript(targets), { timeoutMs: 8_000 });
  if (!String(stdout ?? '').includes('background-clicks-ok')) {
    throw new Error('Background header click did not confirm success.');
  }
  return {
    collection: Boolean(targets.collection),
    tft: Boolean(targets.tft || targets.tftStore),
    tftStore: Boolean(targets.tftStore)
  };
}
