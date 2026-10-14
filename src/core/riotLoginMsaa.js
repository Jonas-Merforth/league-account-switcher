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
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object accessible);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int obtained);
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
}
"@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$deadline = [DateTime]::UtcNow.AddSeconds(18)
$mutated = $false
$persistenceVerified = $false
$lastReason = 'form-not-ready'
try {
  while ([DateTime]::UtcNow -lt $deadline) {
    $candidates = @(Get-Process -Name 'Riot Client','RiotClientUx' -ErrorAction SilentlyContinue | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.Path -and $_.Path.StartsWith($request.riotRoot, [StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($candidate in $candidates) {
      $nodes = [RiotLoginAccessible]::Read($candidate.MainWindowHandle)
      $user = @($nodes | Where-Object { $_.Role -eq 42 -and $_.Name -match '^(?i:username|benutzername)$' })
      $pass = @($nodes | Where-Object { $_.Role -eq 42 -and (($_.State -band 0x20000000) -ne 0 -or $_.Name -match '^(?i:password|passwort)$') })
      $remember = @($nodes | Where-Object { $_.Role -eq 44 -and $_.Name -match '(?i)stay\s+signed|remember|angemeldet bleiben' })
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
      $user[0].Value=[string]$request.username
      $pass[0].Value=[string]$request.password
      if (($remember[0].State -band 0x10) -eq 0) { $remember[0].Invoke() }
      $readyDeadline=[DateTime]::UtcNow.AddSeconds(2)
      while ([DateTime]::UtcNow -lt $readyDeadline -and (($buttons[0].State -band 1) -ne 0 -or ($remember[0].State -band 0x10) -eq 0)) { Start-Sleep -Milliseconds 50 }
      $persistenceVerified=($remember[0].State -band 0x10) -ne 0
      if ($user[0].Value -cne $request.username -or -not $persistenceVerified -or ($buttons[0].State -band 1) -ne 0) { throw 'verification-failed' }
      $buttons[0].Invoke()
      @{submitted=$true;persistenceVerified=$true;method='accessibility-msaa'} | ConvertTo-Json -Compress
      exit 0
    }
    Start-Sleep -Milliseconds 200
  }
  @{submitted=$false;mutated=$mutated;persistenceVerified=$persistenceVerified;reason=$lastReason;method='accessibility-msaa'} | ConvertTo-Json -Compress
} catch {
  @{submitted=$false;mutated=$mutated;persistenceVerified=$persistenceVerified;reason='control-operation-failed';method='accessibility-msaa'} | ConvertTo-Json -Compress
}
`;
