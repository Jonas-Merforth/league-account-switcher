// Chromium's shipped Riot renderer exposes MSAA while its UI Automation tree can be empty.
// This uses the same public accessibility actions as assistive software, inside Riot's process only.
export const RIOT_LOGIN_MSAA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility | Out-Null
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;
public static class RiotLoginAccessible {
  delegate bool EnumWindowProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder text, int maximum);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object accessible);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int obtained);
  [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface AccessibleServiceProvider {
    [PreserveSig] int QueryService(ref Guid service, ref Guid iid, out IntPtr result);
  }
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int AttributesGetter(IntPtr self, out IntPtr result);
  public sealed class Node {
    public IAccessible Owner; public object Id;
    public int Role { get { try { return Convert.ToInt32(Owner.get_accRole(Id)); } catch { return 0; } } }
    public int State { get { try { return Convert.ToInt32(Owner.get_accState(Id)); } catch { return 1; } } }
    public string Name { get { try { return Owner.get_accName(Id) ?? ""; } catch { return ""; } } }
    public string Value { get { return Owner.get_accValue(Id); } set { Owner.set_accValue(Id, value); } }
    public void Invoke() { Owner.accDoDefaultAction(Id); }
    public int[] Bounds() { int x,y,w,h; Owner.accLocation(out x,out y,out w,out h,Id); return new int[]{x,y,w,h}; }
  }
  static void Walk(IAccessible owner, List<Node> nodes, int depth) {
    if (depth > 30 || nodes.Count > 1500) return;
    nodes.Add(new Node { Owner=owner, Id=0 });
    int count; try { count=Math.Min(owner.accChildCount, 250); } catch { return; }
    if (count <= 0) return;
    var children=new object[count]; int obtained;
    if (AccessibleChildren(owner,0,count,children,out obtained) < 0) return;
    for(int i=0;i<obtained;i++) {
      var child=children[i] as IAccessible;
      if(child != null) Walk(child,nodes,depth+1);
      else if(children[i] is int) nodes.Add(new Node { Owner=owner, Id=children[i] });
    }
  }
  public static List<Node> Read(IntPtr hwnd) {
    var nodes=new List<Node>(); object root; var iid=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    if(AccessibleObjectFromWindow(hwnd,0xFFFFFFFC,ref iid,out root)>=0 && root is IAccessible) Walk((IAccessible)root,nodes,0);
    return nodes;
  }
  public static void RequestAccessibility(IntPtr hwnd) {
    // The legacy WM_GETOBJECT handshake enables only basic accessibility in current Chromium.
    // Request IAccessible2 on the renderer root to enable web contents, as an assistive client
    // does. Do not depend on an inspector having populated the tree before the login attempt.
    var handles=new List<IntPtr>(); handles.Add(hwnd);
    EnumChildWindows(hwnd, (child, parameter) => {
      var name=new System.Text.StringBuilder(256);
      GetClassName(child,name,name.Capacity);
      if(name.ToString()=="Chrome_RenderWidgetHostHWND") handles.Add(child);
      return handles.Count<16;
    },IntPtr.Zero);
    foreach(var handle in handles) {
      IntPtr result, extended=IntPtr.Zero, attributes=IntPtr.Zero;
      SendMessageTimeout(handle,0x003D,IntPtr.Zero,new IntPtr(1),2,300,out result);
      try {
        object root; var accessible=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        if(AccessibleObjectFromWindow(handle,0xFFFFFFFC,ref accessible,out root)<0) continue;
        var provider=root as AccessibleServiceProvider; if(provider==null) continue;
        var ia2=new Guid("E89F726E-C4F4-4C19-BB19-B647D7FA8478");
        if(provider.QueryService(ref accessible,ref ia2,out extended)>=0 && extended!=IntPtr.Zero) {
          // IAccessible2::get_attributes also requests extended web properties. Its slot is
          // IUnknown (3) + IDispatch (4) + IAccessible (21) + 17 preceding IA2 methods.
          var address=Marshal.ReadIntPtr(Marshal.ReadIntPtr(extended),45*IntPtr.Size);
          var get=(AttributesGetter)Marshal.GetDelegateForFunctionPointer(address,typeof(AttributesGetter));
          get(extended,out attributes);
        }
      } catch { /* A renderer can be replaced while the login window is loading. Retry below. */ }
      finally {
        if(attributes!=IntPtr.Zero) Marshal.FreeBSTR(attributes);
        if(extended!=IntPtr.Zero) Marshal.Release(extended);
      }
    }
  }
}
"@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$deadline = [DateTime]::UtcNow.AddSeconds(18)
$mutated = $false
$persistenceVerified = $false
$lastReason = 'form-not-ready'
$windowCount = 0
$nodeCount = 0
$fieldCounts = '0/0/0'
$operation = 'find-controls'
try {
  while ([DateTime]::UtcNow -lt $deadline) {
    $candidates = @(Get-Process -Name 'Riot Client','RiotClientUx' -ErrorAction SilentlyContinue | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.Path -and $_.Path.StartsWith($request.riotRoot, [StringComparison]::OrdinalIgnoreCase)
    })
    $windowCount = $candidates.Count
    foreach ($candidate in $candidates) {
      # Retry initialization while the form is unavailable: Chromium can create/replace the
      # renderer child after the top-level window appeared. The web tree arrives asynchronously.
      [RiotLoginAccessible]::RequestAccessibility($candidate.MainWindowHandle)
      $nodes = [RiotLoginAccessible]::Read($candidate.MainWindowHandle)
      $nodeCount = $nodes.Count
      $user = @($nodes | Where-Object { $_.Role -eq 42 -and $_.Name -match '^(?i:username|benutzername)$' })
      $pass = @($nodes | Where-Object { $_.Role -eq 42 -and (($_.State -band 0x20000000) -ne 0 -or $_.Name -match '^(?i:password|passwort)$') })
      $remember = @($nodes | Where-Object { $_.Role -eq 44 -and $_.Name -match '(?i)stay\s+signed|remember|angemeldet bleiben' })
      $fieldCounts = '{0}/{1}/{2}' -f $user.Count,$pass.Count,$remember.Count
      if ($user.Count -ne 1 -or $pass.Count -ne 1 -or $remember.Count -ne 1) { $lastReason='credential-controls-unavailable'; continue }
      if (($user[0].State -band 1) -ne 0 -or ($pass[0].State -band 1) -ne 0) { continue }
      $formBounds = $user[0].Bounds(); $rememberBounds = $remember[0].Bounds()
      $buttons = @($nodes | Where-Object {
        if ($_.Role -ne 43) { return $false }
        $b = $_.Bounds()
        return $b[1] -gt ($rememberBounds[1]+$rememberBounds[3]) -and $b[0] -ge $formBounds[0] -and
          ($b[0]+$b[2]) -le ($formBounds[0]+$formBounds[2]) -and $b[2] -gt 30 -and $b[3] -gt 30
      })
      if ($buttons.Count -ne 1) { $lastReason='submit-control-unavailable'; continue }
      $mutated=$true
      $operation='set-username'
      $user[0].Value=[string]$request.username
      $operation='set-password'
      $pass[0].Value=[string]$request.password
      $operation='enable-persistence'
      if (($remember[0].State -band 0x10) -eq 0) { $remember[0].Invoke() }
      $readyDeadline=[DateTime]::UtcNow.AddSeconds(2)
      while ([DateTime]::UtcNow -lt $readyDeadline -and (($buttons[0].State -band 1) -ne 0 -or ($remember[0].State -band 0x10) -eq 0)) { Start-Sleep -Milliseconds 50 }
      $persistenceVerified=($remember[0].State -band 0x10) -ne 0
      $operation='verify-form'
      if ($user[0].Value -cne $request.username -or -not $persistenceVerified -or ($buttons[0].State -band 1) -ne 0) { throw 'verification-failed' }
      $operation='submit'
      $buttons[0].Invoke()
      @{submitted=$true;persistenceVerified=$true;method='accessibility-msaa'} | ConvertTo-Json -Compress
      exit 0
    }
    Start-Sleep -Milliseconds 200
  }
  @{submitted=$false;mutated=$mutated;persistenceVerified=$persistenceVerified;reason=$lastReason;windowCount=$windowCount;nodeCount=$nodeCount;fieldCounts=$fieldCounts;method='accessibility-msaa'} | ConvertTo-Json -Compress
} catch {
  @{submitted=$false;mutated=$mutated;persistenceVerified=$persistenceVerified;reason='control-operation-failed';operation=$operation;errorCode=$_.Exception.HResult;windowCount=$windowCount;nodeCount=$nodeCount;fieldCounts=$fieldCounts;method='accessibility-msaa'} | ConvertTo-Json -Compress
}
`;
