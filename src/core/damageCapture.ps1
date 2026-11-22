param([Parameter(Mandatory=$true)][string]$SessionDir, [Parameter(Mandatory=$true)][string]$LeaguePath, [switch]$Continuous, [switch]$SmokeTest)
$ErrorActionPreference = 'Stop'
$SessionDir = [IO.Path]::GetFullPath($SessionDir)
$gameExe = Join-Path $LeaguePath 'Game\League of Legends.exe'
$controlDir = $SessionDir
$nextSessionFile = Join-Path $controlDir 'next-session'
$mutex = New-Object Threading.Mutex($false, 'Global\LeagueDamageIpCapture')
$ownsMutex = $false
$started = $null
$gameStarted = $null

function Write-State($phase, $detail) {
    $stateFile = Join-Path $SessionDir 'status.json'
    $state = @{ state = $phase; detail = $detail; startedAt = $started; gameStartedAt = $gameStarted }
    if ($captureLimit) { $state.captureLimit = $captureLimit }
    [IO.File]::WriteAllText("$stateFile.tmp", ($state | ConvertTo-Json -Compress))
    Move-Item -LiteralPath "$stateFile.tmp" -Destination $stateFile -Force
}

function Should-StopHelper {
    if ([IO.File]::Exists((Join-Path $controlDir 'stop-helper'))) { return $true }
    return $controlHeartbeat.HasExpired()
}

function Should-Stop {
    if ([IO.File]::Exists((Join-Path $SessionDir 'stop'))) { return $true }
    return $sessionHeartbeat.HasExpired()
}

$previousGameStart = [DateTime]::MinValue
$busyDetail = 'Another Damage recorder is already running. Close the other app or try again in a minute.'
try {
    Add-Type -Path (Join-Path $controlDir 'DamageIpCapture.cs')
    if ($SmokeTest) { Write-State 'complete' 'IP capture helper compiled'; exit }
    $controlHeartbeat = [DamageHeartbeat]::new($controlDir)
    $sessionHeartbeat = $controlHeartbeat
    # After a restart, the previous app's recorder notices the missing
    # heartbeat within 30 seconds and then releases the lock.
    $lockDeadline = [DamageHeartbeat]::AwakeTicks() + [TimeSpan]::FromSeconds(45).Ticks
    $announced = $false
    while (!$ownsMutex) {
        # A recorder that was killed leaves the lock abandoned. It is then ours.
        try { $ownsMutex = $mutex.WaitOne(500) }
        catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if ($ownsMutex) { break }
        if (!$announced) { Write-State 'starting' 'Waiting for the previous recorder to close'; $announced = $true }
        if ((Should-Stop) -or (Should-StopHelper)) { Write-State 'complete' 'Recorder stopped before a game was found'; exit }
        if ([DamageHeartbeat]::AwakeTicks() -ge $lockDeadline) { throw $busyDetail }
    }
    $captureTicks = [TimeSpan]::FromHours(2).Ticks
    do {
        $started = $null
        $gameStarted = $null
        $captureLimit = $null
        $deadline = if ($Continuous) { [long]::MaxValue } else { [DamageHeartbeat]::AwakeTicks() + $captureTicks }
        Write-State 'waiting' 'Recorder ready. Start a League match.'
        while (!(Should-Stop) -and !(Should-StopHelper) -and [DamageHeartbeat]::AwakeTicks() -lt $deadline) {
        # Vanguard can hide the executable path even from elevated process
        # enumeration. Require the exact process name and a unique fresh log in
        # the configured installation. Reject an available mismatched path.
            $games = @(Get-Process -Name 'League of Legends' -ErrorAction SilentlyContinue | Where-Object { !$_.Path -or $_.Path -eq $gameExe })
            if ($games.Count -ne 1) { Start-Sleep -Milliseconds 500; continue }
            $game = $games[0]
            # The previous game can still be listed after its start time is unavailable.
            try { $startTime = $game.StartTime } catch { $startTime = $null }
            if ($startTime -isnot [DateTime]) { Start-Sleep -Milliseconds 100; continue }
            $gameStart = $startTime.ToUniversalTime()
            if ($gameStart -le $previousGameStart) { Start-Sleep -Milliseconds 100; continue }
            $logs = Get-ChildItem -LiteralPath (Join-Path $LeaguePath 'Logs\GameLogs') -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.CreationTimeUtc -ge $gameStart.AddSeconds(-10) } |
                ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Filter '*_r3dlog.txt' -File -ErrorAction SilentlyContinue } |
                Where-Object { $_.CreationTimeUtc -ge $gameStart.AddSeconds(-10) -and $_.Length -lt 67108864 }
            if (@($logs).Count -ne 1) { Start-Sleep -Milliseconds 100; continue }
            # League may still hold the new log exclusively or replace it.
            $lines = Get-Content -LiteralPath $logs.FullName -TotalCount 200 -ErrorAction SilentlyContinue
            $launch = $lines | Where-Object { $_ -like '*Command*' -and $_ -match '"[0-9.]+ \d+ \S+ \d+"' } | Select-Object -First 1
            if (!$launch) { Start-Sleep -Milliseconds 100; continue }
            $endpoint = [regex]::Match($launch, '"([0-9.]+) (\d+) \S+ \d+"')
            $remote = [Net.IPAddress]::Parse($endpoint.Groups[1].Value); $serverPort = [int]$endpoint.Groups[2].Value
            if ($remote.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $serverPort -lt 1 -or $serverPort -gt 65535) {
                throw 'Unsupported game endpoint.'
            }
            $started = [DateTime]::UtcNow.ToString('o')
            $gameStarted = $gameStart.ToString('o')
            $previousGameStart = $gameStart
            if ($Continuous) { $deadline = [DamageHeartbeat]::AwakeTicks() + $captureTicks }
            Write-State 'capturing' 'Recording game packets at the IP layer'
            $captureLimit = [DamageIpCapture]::Run($SessionDir, $game.Id, $gameStart.Ticks, $remote, $serverPort, $deadline, $sessionHeartbeat)
            if ($captureLimit) {
                Write-State 'capturing' $captureLimit
                while (!$game.HasExited -and !(Should-Stop) -and !(Should-StopHelper)) { Start-Sleep -Milliseconds 250 }
            }
            break
        }
        Write-State 'complete' $(if ($gameStarted) { 'IP-layer capture finished' } else { 'Recorder stopped before a game was found' })
        if (!$Continuous -or (Should-StopHelper)) { break }
        while (!(Should-StopHelper) -and ![IO.File]::Exists($nextSessionFile)) { Start-Sleep -Milliseconds 100 }
        if (Should-StopHelper) { break }
        $next = [IO.File]::ReadAllText($nextSessionFile)
        Remove-Item -LiteralPath $nextSessionFile
        if ($next -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}$') { throw 'Invalid Damage session name.' }
        $SessionDir = Join-Path ([IO.Path]::GetDirectoryName($controlDir)) $next
        $sessionHeartbeat = [DamageHeartbeat]::new($SessionDir)
    } while ($true)
} catch {
    Write-State 'error' $(if ($_.Exception.Message -eq $busyDetail) { $busyDetail } else { 'The IP-layer recorder could not start or stopped unexpectedly.' })
    $failure = '{0}: {1} ({2}, line {3})' -f $_.Exception.GetType().Name, $_.Exception.HResult,
        $_.FullyQualifiedErrorId, $_.InvocationInfo.ScriptLineNumber
    [IO.File]::WriteAllText((Join-Path $SessionDir 'helper-error.txt'), $failure)
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
