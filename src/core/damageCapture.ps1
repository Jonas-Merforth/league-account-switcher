param([Parameter(Mandatory=$true)][string]$SessionDir, [Parameter(Mandatory=$true)][string]$LeaguePath, [switch]$SmokeTest)
$ErrorActionPreference = 'Stop'
$SessionDir = [IO.Path]::GetFullPath($SessionDir)
$gameExe = Join-Path $LeaguePath 'Game\League of Legends.exe'
$stateFile = Join-Path $SessionDir 'status.json'
$mutex = New-Object Threading.Mutex($false, 'Global\LeagueDamageIpCapture')
$ownsMutex = $false
$started = $null
$gameStarted = $null

function Write-State($phase, $detail) {
    $state = @{ state = $phase; detail = $detail; startedAt = $started; gameStartedAt = $gameStarted }
    [IO.File]::WriteAllText("$stateFile.tmp", ($state | ConvertTo-Json -Compress))
    Move-Item -LiteralPath "$stateFile.tmp" -Destination $stateFile -Force
}

function Should-Stop {
    if ([IO.File]::Exists((Join-Path $SessionDir 'stop'))) { return $true }
    $heartbeat = [IO.File]::GetLastWriteTimeUtc((Join-Path $SessionDir 'heartbeat'))
    return ([DateTime]::UtcNow - $heartbeat).TotalSeconds -gt 30
}

try {
    $ownsMutex = $mutex.WaitOne(0)
    if (!$ownsMutex) { throw 'Another Damage capture is already running.' }
    Add-Type -Path (Join-Path $SessionDir 'DamageIpCapture.cs')
    if ($SmokeTest) { Write-State 'complete' 'IP capture helper compiled'; exit }
    $deadline = [DateTime]::UtcNow.AddHours(2)
    Write-State 'waiting' 'Recorder ready. Start a League match.'
    while (!(Should-Stop) -and [DateTime]::UtcNow -lt $deadline) {
        # Vanguard can hide the executable path even from elevated process
        # enumeration. Require the exact process name and a unique fresh log in
        # the configured installation. Reject an available mismatched path.
        $games = @(Get-Process -Name 'League of Legends' -ErrorAction SilentlyContinue | Where-Object { !$_.Path -or $_.Path -eq $gameExe })
        if ($games.Count -ne 1) { Start-Sleep -Milliseconds 100; continue }
        $game = $games[0]
        $gameStart = $game.StartTime.ToUniversalTime()
        $logs = Get-ChildItem -LiteralPath (Join-Path $LeaguePath 'Logs\GameLogs') -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.CreationTimeUtc -ge $gameStart.AddSeconds(-10) } |
            ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*_r3dlog.txt' -File } |
            Where-Object { $_.CreationTimeUtc -ge $gameStart.AddSeconds(-10) -and $_.Length -lt 67108864 }
        if (@($logs).Count -ne 1) { Start-Sleep -Milliseconds 100; continue }
        $lines = Get-Content -LiteralPath $logs.FullName -TotalCount 200
        $launch = $lines | Where-Object { $_ -like '*Command*' -and $_ -match '"[0-9.]+ \d+ \S+ \d+"' } | Select-Object -First 1
        if (!$launch) { Start-Sleep -Milliseconds 100; continue }
        $endpoint = [regex]::Match($launch, '"([0-9.]+) (\d+) \S+ \d+"')
        $remote = [Net.IPAddress]::Parse($endpoint.Groups[1].Value); $serverPort = [int]$endpoint.Groups[2].Value
        if ($remote.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $serverPort -lt 1 -or $serverPort -gt 65535) {
            throw 'Unsupported game endpoint.'
        }
        $started = [DateTime]::UtcNow.ToString('o')
        $gameStarted = $gameStart.ToString('o')
        Write-State 'capturing' 'Recording game packets at the IP layer'
        [DamageIpCapture]::Run($SessionDir, $game.Id, $gameStart.Ticks, $remote, $serverPort, $deadline)
        Write-State 'complete' 'IP-layer capture finished'
        exit
    }
    Write-State 'complete' 'Recorder stopped before a game was found'
} catch {
    Write-State 'error' 'The IP-layer recorder could not start or stopped unexpectedly.'
    [IO.File]::WriteAllText((Join-Path $SessionDir 'helper-error.txt'), $_.Exception.GetType().Name + ': ' + $_.Exception.HResult)
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
