import path from 'node:path';
import { runPowerShell } from './powershell.js';

// The celebration stack is renderer-local: acknowledging its backing rewards does not dismiss
// an already displayed toast. Invoke only its exact accessible Close control, without input,
// focus changes, navigation, or renderer injection. Unknown/ambiguous trees are left alone.
export const LEAGUE_TOAST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility | Out-Null
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;
public static class LeagueToast {
  delegate bool EnumProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int maximum);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object accessible);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int obtained);
  [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ServiceProvider { [PreserveSig] int QueryService(ref Guid service, ref Guid iid, out IntPtr result); }
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetAttributes(IntPtr self, out IntPtr result);
  public static string Attributes(IAccessible owner) {
    IntPtr extended=IntPtr.Zero, value=IntPtr.Zero;
    try {
      var provider=owner as ServiceProvider; if(provider==null) return "";
      var sid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
      var iid=new Guid("E89F726E-C4F4-4C19-BB19-B647D7FA8478");
      if(provider.QueryService(ref sid,ref iid,out extended)<0 || extended==IntPtr.Zero) return "";
      // IUnknown + IDispatch + IAccessible + 17 preceding IAccessible2 methods.
      var address=Marshal.ReadIntPtr(Marshal.ReadIntPtr(extended),45*IntPtr.Size);
      var get=(GetAttributes)Marshal.GetDelegateForFunctionPointer(address,typeof(GetAttributes));
      if(get(extended,out value)<0 || value==IntPtr.Zero) return "";
      return Marshal.PtrToStringBSTR(value);
    } catch { return ""; }
    finally { if(value!=IntPtr.Zero) Marshal.FreeBSTR(value); if(extended!=IntPtr.Zero) Marshal.Release(extended); }
  }
  static bool HasClass(IAccessible owner,string name) {
    var match=System.Text.RegularExpressions.Regex.Match(Attributes(owner),@"(?:^|;)class:([^;]*)");
    if(!match.Success) return false;
    foreach(var part in System.Text.RegularExpressions.Regex.Split(match.Groups[1].Value,@"\s+")) if(part==name) return true;
    return false;
  }
  public static bool IsTarget(IAccessible node) {
    try {
      if(!HasClass(node,"lol-uikit-dialog-frame-toast-close-button")) return false;
      var parent=node.accParent as IAccessible;
      for(int depth=0;parent!=null && depth<30;depth++) {
        if(HasClass(parent,"lol-uikit-toast-celebration-layer")) return true;
        parent=parent.accParent as IAccessible;
      }
    } catch { }
    return false;
  }
  public sealed class Node { public IAccessible Owner; }
  public static bool CanInvoke(Node target) {
    var node=target.Owner;
    try {
      if(!IsTarget(node) || (Convert.ToInt32(node.get_accState(0)) & 0x18001)!=0) return false;
      int x,y,w,h; node.accLocation(out x,out y,out w,out h,0);
      return w>0 && h>0 && !String.IsNullOrEmpty(node.get_accDefaultAction(0));
    } catch { return false; }
  }
  public static List<IntPtr> Renderers(IntPtr window) {
    var handles=new List<IntPtr>();
    EnumChildWindows(window,(child,parameter)=>{
      var name=new System.Text.StringBuilder(256); GetClassName(child,name,name.Capacity);
      if(name.ToString()=="Chrome_RenderWidgetHostHWND") handles.Add(child);
      return handles.Count<16;
    },IntPtr.Zero);
    return handles;
  }
  static IAccessible Root(IntPtr window) {
    object root; var iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    return AccessibleObjectFromWindow(window,0xFFFFFFFC,ref iid,out root)>=0 ? root as IAccessible : null;
  }
  public static void Enable(IntPtr window) {
    IntPtr result; SendMessageTimeout(window,0x003D,IntPtr.Zero,new IntPtr(1),2,300,out result);
    var root=Root(window); if(root!=null) Attributes(root);
  }
  public sealed class Scan {
    public List<Node> Targets=new List<Node>();
    public int Nodes; public bool Complete=true;
  }
  static void Walk(IAccessible node, Scan scan, int depth) {
    if(depth>40 || ++scan.Nodes>3000) { scan.Complete=false; return; }
    try {
      if(IsTarget(node)) scan.Targets.Add(new Node { Owner=node });
      int count=node.accChildCount;
      if(count>500) { scan.Complete=false; return; }
      if(count<=0) return;
      var children=new object[count]; int obtained;
      if(AccessibleChildren(node,0,count,children,out obtained)<0) { scan.Complete=false; return; }
      for(int i=0;i<obtained;i++) {
        var child=children[i] as IAccessible;
        if(child!=null) Walk(child,scan,depth+1);
        if(!scan.Complete) return;
      }
    } catch { scan.Complete=false; }
  }
  public static Scan Read(IntPtr window) {
    var scan=new Scan(); var root=Root(window);
    if(root!=null) Walk(root,scan,0); else scan.Complete=false;
    return scan;
  }
  public static void Invoke(Node node) { node.Owner.accDoDefaultAction(0); }
  public static string ReadLock(string path) {
    using(var file=new System.IO.FileStream(path,System.IO.FileMode.Open,System.IO.FileAccess.Read,System.IO.FileShare.ReadWrite | System.IO.FileShare.Delete))
    using(var reader=new System.IO.StreamReader(file)) return reader.ReadToEnd();
  }
  // Per-request TLS acceptance is limited to this localhost LCU request in this short-lived helper.
  public static string Phase(int port,string password) {
    var request=(System.Net.HttpWebRequest)System.Net.WebRequest.Create("https://127.0.0.1:"+port+"/lol-gameflow/v1/gameflow-phase");
    request.ServerCertificateValidationCallback=(sender,certificate,chain,errors)=>true;
    request.Timeout=1500;
    request.Headers["Authorization"]="Basic "+Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("riot:"+password));
    using(var response=request.GetResponse()) using(var reader=new System.IO.StreamReader(response.GetResponseStream())) return reader.ReadToEnd();
  }
}
"@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$report = @{dismissed=$false;reason='no-toast';candidates=0;foregroundUnchanged=$true;cursorUnchanged=$true}
try {
  $candidates = @(Get-Process -Name 'LeagueClientUx' -ErrorAction SilentlyContinue | Where-Object {
    $_.MainWindowHandle -ne 0 -and [string]::Equals($_.Path,$request.executable,[StringComparison]::OrdinalIgnoreCase)
  })
  if ($candidates.Count -ne 1) { $report.reason='window-unavailable'; $report | ConvertTo-Json -Compress; exit }
  $candidate=$candidates[0]
  # Never follow a newly signed-in client while this sweep belongs to the previous session.
  $parent=(Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.Id)").ParentProcessId
  if ($parent -ne $request.clientPid) { $report.reason='session-changed'; $report | ConvertTo-Json -Compress; exit }
  $handles=[LeagueToast]::Renderers($candidate.MainWindowHandle)
  if ($handles.Count -ne 1) { $report.reason='renderer-unavailable'; $report | ConvertTo-Json -Compress; exit }
  $handle=$handles[0]
  # Chromium populates web accessibility asynchronously. Retry a small native-only tree;
  # don't depend on an inspector having enabled it before the sweep.
  for ($attempt=0; $attempt -lt 5; $attempt++) {
    [LeagueToast]::Enable($candidate.MainWindowHandle)
    [LeagueToast]::Enable($handle)
    Start-Sleep -Milliseconds 250
    $scan=[LeagueToast]::Read($handle)
    if ($scan.Nodes -gt 20) { break }
  }
  $report.candidates=$scan.Targets.Count
  if (!$scan.Complete) { $report.reason='incomplete-tree' }
  elseif ($scan.Targets.Count -gt 1) { $report.reason='ambiguous-toast' }
  elseif ($scan.Targets.Count -eq 1 -and [LeagueToast]::CanInvoke($scan.Targets[0])) {
    $phase=[LeagueToast]::Phase($request.port,$request.password) | ConvertFrom-Json
    $lock=[LeagueToast]::ReadLock($request.lockfile).Trim().Split(':')
    if ($lock[1] -ne [string]$request.clientPid -or $lock[2] -ne [string]$request.port -or $lock[3] -cne $request.password) { $report.reason='session-changed' }
    elseif ($phase -notin @('None','Lobby','Matchmaking')) { $report.reason='phase-blocked' }
    elseif ([LeagueToast]::CanInvoke($scan.Targets[0])) {
      $foreground=[LeagueToast]::GetForegroundWindow()
      $cursor=New-Object LeagueToast+Point
      [void][LeagueToast]::GetCursorPos([ref]$cursor)
      [LeagueToast]::Invoke($scan.Targets[0])
      Start-Sleep -Milliseconds 300
      $after=[LeagueToast]::Read($handle)
      $report.dismissed=$after.Complete -and $after.Targets.Count -eq 0
      $report.reason=if($report.dismissed){'dismissed'}else{'not-confirmed'}
      $report.foregroundUnchanged=$foreground -eq [LeagueToast]::GetForegroundWindow()
      $afterCursor=New-Object LeagueToast+Point
      [void][LeagueToast]::GetCursorPos([ref]$afterCursor)
      $report.cursorUnchanged=$cursor.X -eq $afterCursor.X -and $cursor.Y -eq $afterCursor.Y
    }
  }
} catch { $report.reason='accessibility-unavailable' }
$report | ConvertTo-Json -Compress
`;

export async function dismissLeagueCelebrationToast(lcu) {
  if (process.platform !== 'win32') return { dismissed: false, reason: 'unsupported-platform' };
  const session = lcu.forCurrentSession();
  const credentials = session.getCredentials();
  const output = await runPowerShell(LEAGUE_TOAST_SCRIPT, {
    input: JSON.stringify({
      executable: path.join(session.leaguePath, 'LeagueClientUx.exe'),
      lockfile: path.join(session.leaguePath, 'lockfile'),
      clientPid: credentials.pid, port: credentials.port, password: credentials.password
    }),
    timeoutMs: 12000
  });
  return JSON.parse(output.trim());
}
