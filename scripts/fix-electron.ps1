# Repairs node_modules/electron when its binary is missing. On some Node/Windows setups npm's
# allow-scripts gate skips Electron's postinstall, and even running it the bundled extractor
# (extract-zip) silently fails (only LICENSES.chromium.html lands in dist, no electron.exe).
# This extracts the Electron zip with PowerShell Expand-Archive instead (which works), using the
# already-downloaded cache if present, otherwise downloading it. Run:  npm run fix-electron
$ErrorActionPreference = 'Stop'

$root  = Split-Path -Parent $PSScriptRoot
$elDir = Join-Path $root 'node_modules\electron'
if (-not (Test-Path $elDir)) { throw 'node_modules/electron not found - run "npm install" first.' }

$version = (Get-Content (Join-Path $elDir 'package.json') -Raw | ConvertFrom-Json).version
$dist    = Join-Path $elDir 'dist'
$zipName = "electron-v$version-win32-x64.zip"

if (Test-Path (Join-Path $dist 'electron.exe')) {
  Write-Host ("electron.exe already present (v{0}) - nothing to do." -f $version)
  exit 0
}

$cache = Join-Path $env:LOCALAPPDATA 'electron\Cache'
$zip = Get-ChildItem -Path $cache -Recurse -Filter $zipName -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $zip) {
  Write-Host ("No cached {0}, downloading from GitHub..." -f $zipName)
  $tmp = Join-Path $env:TEMP $zipName
  Invoke-WebRequest -Uri ("https://github.com/electron/electron/releases/download/v{0}/{1}" -f $version, $zipName) -OutFile $tmp
  $zip = Get-Item $tmp
}

Write-Host ("Extracting {0} into node_modules\electron\dist ..." -f $zip.Name)
Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dist | Out-Null
Expand-Archive -Path $zip.FullName -DestinationPath $dist -Force
'electron.exe' | Set-Content -NoNewline (Join-Path $elDir 'path.txt')

if (Test-Path (Join-Path $dist 'electron.exe')) {
  Write-Host ("OK - Electron v{0} ready. You can now run: npm start" -f $version)
} else {
  throw 'Extraction did not produce electron.exe.'
}
