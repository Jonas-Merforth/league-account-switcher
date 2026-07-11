import { runPowerShell } from './powershell.js';
import { LEAGUE_HEADER_RATIOS } from './leagueHeaderClicks.js';

// The Activity Center sidebar is authored against Riot's 1280x720 layout. The League client scales
// those CSS pixels uniformly, so ratios remain stable across the supported client sizes. The first
// eight rows are safely clickable from the top; after scrolling to the bottom, the last eight are.
// That covers up to sixteen dynamic rows without screenshot/pixel detection.
export const ACTIVITY_CENTER_LAYOUT = Object.freeze({
  sidebarX: 100 / 1280,
  firstTabY: 124 / 720,
  tabStepY: 61 / 720,
  bottomLastTabY: 583 / 720,
  stickyFirstY: 663 / 720,
  stickyStepY: 43 / 720,
  topVisibleCount: 8,
  bottomVisibleCount: 8,
  maxDynamicTabs: 16,
  wheelY: 360 / 720
});

function ratioLiteral(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1) {
    throw new Error(`Invalid League Activity Center ratio: ${value}`);
  }
  return String(number);
}

function normalizedIndices(values, count, label) {
  const normalized = [...new Set(Array.isArray(values) ? values : [])].sort((left, right) => left - right);
  for (const value of normalized) {
    if (!Number.isInteger(value) || value < 0 || value >= count) {
      throw new Error(`Invalid ${label} index ${value} for ${count} items.`);
    }
  }
  return normalized;
}

export function buildActivityCenterClickPlan({
  tabCount = 0,
  tabIndices = [],
  stickyCount = 0,
  stickyIndices = []
} = {}) {
  const dynamicCount = Number(tabCount);
  const footerCount = Number(stickyCount);
  if (!Number.isInteger(dynamicCount) || dynamicCount < 0) {
    throw new Error(`Invalid Activity Center tab count: ${tabCount}`);
  }
  if (!Number.isInteger(footerCount) || footerCount < 0 || footerCount > 2) {
    throw new Error(`Invalid Activity Center sticky-tab count: ${stickyCount}`);
  }

  const requestedTabs = normalizedIndices(tabIndices, dynamicCount, 'Activity Center tab');
  const requestedSticky = normalizedIndices(stickyIndices, footerCount, 'Activity Center sticky tab');
  const top = [];
  const bottom = [];
  for (const index of requestedTabs) {
    if (index < ACTIVITY_CENTER_LAYOUT.topVisibleCount) {
      top.push({
        index,
        y: ACTIVITY_CENTER_LAYOUT.firstTabY + (index * ACTIVITY_CENTER_LAYOUT.tabStepY)
      });
      continue;
    }
    const distanceFromEnd = dynamicCount - 1 - index;
    if (distanceFromEnd < ACTIVITY_CENTER_LAYOUT.bottomVisibleCount) {
      bottom.push({
        index,
        y: ACTIVITY_CENTER_LAYOUT.bottomLastTabY - (distanceFromEnd * ACTIVITY_CENTER_LAYOUT.tabStepY)
      });
      continue;
    }
    throw new Error(
      `Activity Center has ${dynamicCount} dynamic tabs; tab ${index} is outside the safe top/bottom click ranges.`
    );
  }

  if (dynamicCount > ACTIVITY_CENTER_LAYOUT.maxDynamicTabs && requestedTabs.length > 0) {
    const covered = new Set([...top, ...bottom].map((entry) => entry.index));
    if (covered.size !== requestedTabs.length) {
      throw new Error(`Activity Center has too many dynamic tabs to clear safely: ${dynamicCount}`);
    }
  }

  const sticky = requestedSticky.map((index) => ({
    index,
    y: ACTIVITY_CENTER_LAYOUT.stickyFirstY + (index * ACTIVITY_CENTER_LAYOUT.stickyStepY)
  }));
  return { tabCount: dynamicCount, top, bottom, sticky };
}

export function buildBackgroundActivityCenterClickScript(targets = {}) {
  const plan = buildActivityCenterClickPlan(targets);
  const hasTargets = plan.top.length > 0 || plan.bottom.length > 0 || plan.sticky.length > 0;
  const click = (x, y, label) =>
    `Invoke-BackgroundClick ${ratioLiteral(x)} ${ratioLiteral(y)} '${label}'`;
  const lines = [];
  if (hasTargets) {
    lines.push(click(LEAGUE_HEADER_RATIOS.league.x, LEAGUE_HEADER_RATIOS.league.y, 'League home'));
    lines.push(`Invoke-BackgroundWheel ${ratioLiteral(ACTIVITY_CENTER_LAYOUT.sidebarX)} ${ratioLiteral(ACTIVITY_CENTER_LAYOUT.wheelY)} 120 10 'Activity Center top'`);
    for (const target of plan.top) {
      lines.push(click(ACTIVITY_CENTER_LAYOUT.sidebarX, target.y, `Activity Center tab ${target.index}`));
    }
    if (plan.bottom.length > 0) {
      lines.push(`Invoke-BackgroundWheel ${ratioLiteral(ACTIVITY_CENTER_LAYOUT.sidebarX)} ${ratioLiteral(ACTIVITY_CENTER_LAYOUT.wheelY)} -120 10 'Activity Center bottom'`);
      for (const target of plan.bottom) {
        lines.push(click(ACTIVITY_CENTER_LAYOUT.sidebarX, target.y, `Activity Center tab ${target.index}`));
      }
    }
    for (const target of plan.sticky) {
      lines.push(click(ACTIVITY_CENTER_LAYOUT.sidebarX, target.y, `Activity Center sticky tab ${target.index}`));
    }
    // Finish on the default/featured League home card rather than Patch Notes or another event.
    if (plan.tabCount > 0) {
      lines.push(`Invoke-BackgroundWheel ${ratioLiteral(ACTIVITY_CENTER_LAYOUT.sidebarX)} ${ratioLiteral(ACTIVITY_CENTER_LAYOUT.wheelY)} 120 10 'Activity Center top'`);
      lines.push(click(ACTIVITY_CENTER_LAYOUT.sidebarX, ACTIVITY_CENTER_LAYOUT.firstTabY, 'Activity Center default tab'));
    } else {
      lines.push(click(LEAGUE_HEADER_RATIOS.league.x, LEAGUE_HEADER_RATIOS.league.y, 'League home'));
    }
  }

  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class LeagueActivityCenterBgClick {
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
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  public static IntPtr MakeLParam(int x, int y) { return new IntPtr(((long)(y & 0xFFFF) << 16) | (uint)(x & 0xFFFF)); }
  public static IntPtr MakeWheelWParam(int delta) { return new IntPtr((long)(ushort)(short)delta << 16); }
  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const uint WM_MOUSEWHEEL = 0x020A;
  public const int MK_LBUTTON = 0x0001;
  public const int SW_SHOWNOACTIVATE = 4;
  public const int SW_SHOWMINNOACTIVE = 7;
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
}
"@

$script:target = [IntPtr]::Zero
[LeagueActivityCenterBgClick]::EnumWindows({
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [LeagueActivityCenterBgClick]::IsWindowVisible($hWnd)) { return $true }
  $procId = [uint32]0
  [void][LeagueActivityCenterBgClick]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  $processName = ''
  try { $processName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  if ($processName -eq 'LeagueClientUx') {
    $title = [System.Text.StringBuilder]::new(256)
    [void][LeagueActivityCenterBgClick]::GetWindowText($hWnd, $title, $title.Capacity)
    if ($title.ToString() -match 'League of Legends') {
      $script:target = $hWnd
      return $false
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null

if ($script:target -eq [IntPtr]::Zero) { throw 'League client window not found.' }

$wasMinimized = $false
if ([LeagueActivityCenterBgClick]::IsIconic($script:target)) {
  [void][LeagueActivityCenterBgClick]::ShowWindow($script:target, [LeagueActivityCenterBgClick]::SW_SHOWNOACTIVATE)
  $wasMinimized = $true
  Start-Sleep -Milliseconds 400
}

try {
  $script:cef = [IntPtr]::Zero
  [LeagueActivityCenterBgClick]::EnumChildWindows($script:target, {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $className = [System.Text.StringBuilder]::new(256)
    [void][LeagueActivityCenterBgClick]::GetClassName($hWnd, $className, $className.Capacity)
    if ($className.ToString() -eq 'Chrome_RenderWidgetHostHWND') {
      $script:cef = $hWnd
      return $false
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($script:cef -eq [IntPtr]::Zero) { throw 'League CEF input window not found.' }

  $rect = [LeagueActivityCenterBgClick+RECT]::new()
  [void][LeagueActivityCenterBgClick]::GetClientRect($script:cef, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 900 -or $height -lt 500) { throw "League client window is too small: $width x $height" }

  function Invoke-BackgroundClick([double]$xRatio, [double]$yRatio, [string]$label) {
    $x = [int]($width * $xRatio)
    $y = [int]($height * $yRatio)
    $lp = [LeagueActivityCenterBgClick]::MakeLParam($x, $y)
    if (-not [LeagueActivityCenterBgClick]::PostMessage($script:cef, [LeagueActivityCenterBgClick]::WM_MOUSEMOVE, [IntPtr]::Zero, $lp)) { throw "PostMessage move failed for $label" }
    Start-Sleep -Milliseconds 60
    if (-not [LeagueActivityCenterBgClick]::PostMessage($script:cef, [LeagueActivityCenterBgClick]::WM_LBUTTONDOWN, [IntPtr][LeagueActivityCenterBgClick]::MK_LBUTTON, $lp)) { throw "PostMessage down failed for $label" }
    Start-Sleep -Milliseconds 40
    if (-not [LeagueActivityCenterBgClick]::PostMessage($script:cef, [LeagueActivityCenterBgClick]::WM_LBUTTONUP, [IntPtr]::Zero, $lp)) { throw "PostMessage up failed for $label" }
    Start-Sleep -Milliseconds 450
    Write-Output ("clicked-activity-center-bg {0}" -f $label)
  }

  function Invoke-BackgroundWheel([double]$xRatio, [double]$yRatio, [int]$delta, [int]$count, [string]$label) {
    $point = [LeagueActivityCenterBgClick+POINT]::new()
    $point.X = [int]($width * $xRatio)
    $point.Y = [int]($height * $yRatio)
    if (-not [LeagueActivityCenterBgClick]::ClientToScreen($script:cef, [ref]$point)) { throw "ClientToScreen failed for $label" }
    $lp = [LeagueActivityCenterBgClick]::MakeLParam($point.X, $point.Y)
    $wp = [LeagueActivityCenterBgClick]::MakeWheelWParam($delta)
    for ($index = 0; $index -lt $count; $index++) {
      if (-not [LeagueActivityCenterBgClick]::PostMessage($script:cef, [LeagueActivityCenterBgClick]::WM_MOUSEWHEEL, $wp, $lp)) { throw "PostMessage wheel failed for $label" }
      Start-Sleep -Milliseconds 35
    }
    Start-Sleep -Milliseconds 150
    Write-Output ("scrolled-activity-center-bg {0}" -f $label)
  }

${lines.length ? lines.map((line) => `  ${line}`).join('\n') : "  Write-Output 'nothing to click'"}
  Write-Output 'activity-center-background-clicks-ok'
} finally {
  if ($wasMinimized) {
    [void][LeagueActivityCenterBgClick]::ShowWindow($script:target, [LeagueActivityCenterBgClick]::SW_SHOWMINNOACTIVE)
  }
}
`;
}

export async function clearLeagueActivityCenterIndicatorsBackground(targets) {
  const plan = buildActivityCenterClickPlan(targets);
  if (plan.top.length === 0 && plan.bottom.length === 0 && plan.sticky.length === 0) {
    return { home: false, mode: null };
  }
  const stdout = await runPowerShell(buildBackgroundActivityCenterClickScript(targets), { timeoutMs: 15_000 });
  if (!String(stdout ?? '').includes('activity-center-background-clicks-ok')) {
    throw new Error('Background Activity Center click did not confirm success.');
  }
  return { home: true, mode: 'background' };
}
