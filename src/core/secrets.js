import { runPowerShell } from './powershell.js';

// Windows DPAPI (CurrentUser scope) encryption for at-rest secrets: stored account passwords
// and captured Riot session snapshots. Ciphertext is only decryptable by the same Windows user
// on the same machine. Everything crosses the PowerShell boundary as base64 on stdin so binary
// content survives intact and no secret is ever placed on a command line.

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inB64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($inB64)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inB64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($inB64)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

// Encrypt a UTF-8 string, returning base64 DPAPI ciphertext.
export async function dpapiProtect(plain) {
  const inputB64 = Buffer.from(String(plain ?? ''), 'utf8').toString('base64');
  const out = await runPowerShell(PROTECT_SCRIPT, { input: inputB64 });
  const cipher = out.trim();
  if (!cipher) throw new Error('DPAPI protect returned no data.');
  return cipher;
}

// Decrypt base64 DPAPI ciphertext back to the original UTF-8 string.
export async function dpapiUnprotect(cipherBase64) {
  const out = await runPowerShell(UNPROTECT_SCRIPT, { input: String(cipherBase64 ?? '') });
  return Buffer.from(out.trim(), 'base64').toString('utf8');
}
