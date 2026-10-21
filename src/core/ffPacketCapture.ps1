param([Parameter(Mandatory=$true)][string]$SessionDir, [switch]$SmokeTest)
$ErrorActionPreference = 'Stop'
$SessionDir = [IO.Path]::GetFullPath($SessionDir)
$statusPath = Join-Path $SessionDir 'status.json'
$etl = Join-Path $SessionDir 'packets.etl'
$pcap = Join-Path $SessionDir 'packets.pcapng'
$pktmon = Join-Path $env:SystemRoot 'System32\pktmon.exe'
$started = $false
$filtersAdded = $false
$locked = $false
$mutex = New-Object Threading.Mutex($false, 'Global\LeagueFFResearchPacketCapture')
$state = @{ state = 'starting'; detail = 'Preparing packet capture'; ports = @(); startedAt = $null; stoppedAt = $null; smokeTest = [bool]$SmokeTest }
function Save-State($phase, $detail) {
    $state.state = $phase; $state.detail = $detail; $state.updatedAt = [DateTime]::UtcNow.ToString('o')
    $json = $state | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText("$statusPath.tmp", $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath "$statusPath.tmp" -Destination $statusPath -Force
}
function Invoke-Pkt([string[]]$Arguments) {
    $result = (& $pktmon @Arguments 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "pktmon $($Arguments[0]) failed: $result" }
    return $result
}
function Should-Stop {
    if (Test-Path -LiteralPath (Join-Path $SessionDir 'stop')) { return $true }
    $heartbeat = Get-Item -LiteralPath (Join-Path $SessionDir 'heartbeat') -ErrorAction SilentlyContinue
    return (!$heartbeat -or ([DateTime]::UtcNow - $heartbeat.LastWriteTimeUtc).TotalSeconds -gt 30)
}
try {
    $locked = $mutex.WaitOne(0)
    if (!$locked) { throw 'Another FF packet helper is active.' }
    # PktMon filters are machine-wide and ORed. Never clear or widen an existing setup.
    $initialStatus = Invoke-Pkt @('status')
    $initialFilters = Invoke-Pkt @('filter', 'list')
    $state.preflight = @{ status = $initialStatus; filters = $initialFilters }
    if ($initialStatus -notmatch '(?i)\b(stopped|not running)\b') { throw 'PktMon is already running or its status is not recognized. Existing session left untouched.' }
    if ($initialFilters -notmatch '(?i)(no (packet )?filters|Packet Filters:\s+None\s*$)') { throw 'Existing PktMon filters or unrecognized filter output. Existing configuration left untouched.' }
    Save-State 'waiting' 'Administrator helper ready; waiting for the running game UDP sockets'
    $deadline = [DateTime]::UtcNow.AddHours(2)
    $game = $null
    while (!(Should-Stop) -and [DateTime]::UtcNow -lt $deadline) {
        if ($SmokeTest) {
            $gateway = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 -ExpandProperty NextHop
            if (!$gateway -or $gateway -eq '0.0.0.0') { throw 'No IPv4 gateway for the controlled UDP capture test.' }
            $ports = @(54329); break
        }
        $game = Get-Process -Name 'League of Legends' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($game) {
            $ports = @(Get-NetUDPEndpoint -OwningProcess $game.Id -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
            if ($ports.Count -gt 0) {
                Start-Sleep -Seconds 2
                $ports = @(Get-NetUDPEndpoint -OwningProcess $game.Id -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
                if ($ports.Count -gt 0) { break }
            }
        }
        Start-Sleep -Milliseconds 1000
    }
    if ((Should-Stop) -or [DateTime]::UtcNow -ge $deadline) { Save-State 'complete' 'Stopped before a game socket was available'; exit }
    if ($ports.Count -gt 16) { throw 'Unexpected number of game UDP sockets; refusing broad capture.' }
    # Check again after waiting, before modifying global PktMon state.
    if ((Invoke-Pkt @('status')) -notmatch '(?i)\b(stopped|not running)\b' -or
        (Invoke-Pkt @('filter','list')) -notmatch '(?i)(no (packet )?filters|Packet Filters:\s+None\s*$)') { throw 'PktMon configuration changed while waiting; left untouched.' }
    foreach ($port in $ports) {
        $arguments = @('filter', 'add', "FFResearch-$port", '-t', 'UDP', '-p', [string]$port)
        if ($SmokeTest) { $arguments += @('-i', $gateway) }
        $null = Invoke-Pkt $arguments
        $filtersAdded = $true
    }
    $state.ports = @($ports); $state.processId = if ($game) { $game.Id } else { $null }
    $state.filterDescription = 'UDP matching game-owned local ports, either direction; NIC capture; full packet bytes'
    $state.sizeLimitMB = 2048; $state.retention = 'Circular: earliest packets may be overwritten at 2 GB; two-hour helper limit'
    $state.startOutput = Invoke-Pkt @('start','--capture','--comp','nics','--pkt-size','0','--file-name',$etl,'--file-size','2048','--log-mode','circular')
    $started = $true; $state.startedAt = [DateTime]::UtcNow.ToString('o')
    Save-State 'capturing' 'PktMon running; packet count is verified after conversion'
    if ($SmokeTest) {
        $udp = New-Object Net.Sockets.UdpClient
        try {
            $payload = [Text.Encoding]::ASCII.GetBytes('FF_RESEARCH_CAPTURE_SMOKE_TEST')
            for ($i = 0; $i -lt 5; $i++) { $null = $udp.Send($payload, $payload.Length, $gateway, 54329); Start-Sleep -Milliseconds 200 }
        } finally { $udp.Dispose() }
    } else {
        $nextSocketCheck = [DateTime]::UtcNow.AddSeconds(5)
        while (!(Should-Stop) -and [DateTime]::UtcNow -lt $deadline) {
            if (!(Get-Process -Id $game.Id -ErrorAction SilentlyContinue)) { break }
            if ([DateTime]::UtcNow -ge $nextSocketCheck) {
                $nextSocketCheck = [DateTime]::UtcNow.AddSeconds(5)
                $currentPorts = @(Get-NetUDPEndpoint -OwningProcess $game.Id -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
                $missing = @($currentPorts | Where-Object { $_ -notin $ports })
                if ($missing.Count) {
                    $state.uncoveredPorts = $missing
                    throw 'Game UDP sockets changed. Partial capture saved; restart recording to cover the new sockets.'
                }
            }
            Start-Sleep -Milliseconds 500
        }
    }
} catch {
    $state.error = $_.Exception.Message
} finally {
    if ($started) {
        try {
            Save-State 'converting' 'Stopping capture and converting full packet data to PCAPNG'
            $currentStatus = Invoke-Pkt @('status')
            if ($currentStatus -notmatch [regex]::Escape($etl)) {
                $filtersAdded = $false
                throw 'PktMon session ownership changed; refusing to stop or clear another session. Original ETL retained.'
            }
            $state.stopOutput = Invoke-Pkt @('stop')
            $state.stoppedAt = [DateTime]::UtcNow.ToString('o')
            $state.conversionOutput = Invoke-Pkt @('etl2pcap', $etl, '--out', $pcap)
            if (!(Test-Path -LiteralPath $pcap)) { throw 'Conversion did not create packets.pcapng' }
            $state.pcapBytes = (Get-Item -LiteralPath $pcap).Length
        } catch { $state.error = $_.Exception.Message }
    }
    if ($filtersAdded) {
        try {
            $currentFilters = Invoke-Pkt @('filter','list')
            $filterRows = @($currentFilters -split "`n" | Where-Object { $_ -match '^\s*\d+\s+' })
            if (@($filterRows | Where-Object { $_ -notmatch '^\s*\d+\s+FFResearch-\d+\s+' }).Count) {
                throw 'Other filters appeared during capture; filters left untouched.'
            }
            $null = Invoke-Pkt @('filter','remove')
        } catch { $state.cleanupError = $_.Exception.Message }
    }
    if ($state.error) { Save-State 'error' $state.error }
    elseif ($state.cleanupError) { Save-State 'error' "Capture saved but filter cleanup failed: $($state.cleanupError)" }
    elseif ($started) { Save-State 'complete' 'PCAPNG saved; awaiting packet validation' }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
