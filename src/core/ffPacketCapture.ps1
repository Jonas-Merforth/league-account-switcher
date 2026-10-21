param([Parameter(Mandatory=$true)][string]$SessionDir, [switch]$SmokeTest)
$ErrorActionPreference = 'Stop'
$SessionDir = [IO.Path]::GetFullPath($SessionDir)
$statusPath = Join-Path $SessionDir 'status.json'
$pcap = Join-Path $SessionDir 'packets.pcapng'
$pktmon = Join-Path $env:SystemRoot 'System32\pktmon.exe'
$started = $false
$filtersAdded = $false
$locked = $false
$segments = @()
$mutex = New-Object Threading.Mutex($false, 'Global\LeagueFFResearchPacketCapture')
$state = @{ state = 'starting'; detail = 'Preparing packet capture'; ports = @(); startedAt = $null; stoppedAt = $null; smokeTest = [bool]$SmokeTest; socketChanges = @() }
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
function Get-GamePorts { @(Get-NetUDPEndpoint -OwningProcess $game.Id -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique) }
function Add-Filters([int[]]$NewPorts) {
    foreach ($port in $NewPorts) {
        $arguments = @('filter', 'add', "FFResearch-$port", '-t', 'UDP', '-p', [string]$port)
        if ($SmokeTest) { $arguments += @('-i', $gateway) }
        $null = Invoke-Pkt $arguments
        $script:filtersAdded = $true
    }
}
# Each PktMon run writes its own ETL segment; segments are converted and joined at the end.
function Start-Segment {
    $suffix = if ($script:segments.Count) { "-$($script:segments.Count + 1)" } else { '' }
    $etl = Join-Path $SessionDir "packets$suffix.etl"
    $output = Invoke-Pkt @('start','--capture','--comp','nics','--pkt-size','0','--file-name',$etl,'--file-size','2048','--log-mode','circular')
    $script:segments += $etl; $script:started = $true
    if (!$state.startedAt) { $state.startedAt = [DateTime]::UtcNow.ToString('o'); $state.startOutput = $output }
    $state.segments = @($script:segments | ForEach-Object { Split-Path -Leaf $_ })
}
function Stop-Segment {
    $etl = $script:segments[-1]
    if ((Invoke-Pkt @('status')) -notmatch [regex]::Escape($etl)) {
        $script:filtersAdded = $false
        throw 'PktMon session ownership changed; refusing to stop or clear another session. Original ETL retained.'
    }
    $state.stopOutput = Invoke-Pkt @('stop')
    $script:started = $false
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
            $ports = Get-GamePorts
            if ($ports.Count -gt 0) {
                Start-Sleep -Seconds 2
                $ports = Get-GamePorts
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
    Add-Filters $ports
    $state.ports = @($ports); $state.processId = if ($game) { $game.Id } else { $null }
    $state.filterDescription = 'UDP matching game-owned local ports, either direction; NIC capture; full packet bytes'
    $state.sizeLimitMB = 2048; $state.retention = 'Circular: earliest packets may be overwritten at 2 GB per segment; two-hour helper limit'
    Start-Segment
    Save-State 'capturing' 'PktMon running; packet count is verified after conversion'
    if ($SmokeTest) {
        $udp = New-Object Net.Sockets.UdpClient
        try {
            $payload = [Text.Encoding]::ASCII.GetBytes('FF_RESEARCH_CAPTURE_SMOKE_TEST')
            for ($i = 0; $i -lt 5; $i++) { $null = $udp.Send($payload, $payload.Length, $gateway, 54329); Start-Sleep -Milliseconds 200 }
            # Exercise the mid-capture socket change: a second port joins and must be recorded too.
            $missing = @(54330)
        } finally { $udp.Dispose() }
    } else {
        $missing = @()
        $nextSocketCheck = [DateTime]::UtcNow.AddSeconds(5)
    }
    while (!(Should-Stop) -and [DateTime]::UtcNow -lt $deadline) {
        if (!$SmokeTest) {
            if (!(Get-Process -Id $game.Id -ErrorAction SilentlyContinue)) { break }
            if ([DateTime]::UtcNow -ge $nextSocketCheck) {
                $nextSocketCheck = [DateTime]::UtcNow.AddSeconds(5)
                $missing = @(Get-GamePorts | Where-Object { $_ -notin $ports })
            }
        }
        if ($missing.Count) {
            # Filters are only guaranteed to apply at start, so restart into a new segment. The gap is about a second.
            if ($ports.Count + $missing.Count -gt 16) { throw 'Unexpected number of game UDP sockets; refusing broad capture.' }
            Save-State 'capturing' "Game opened new UDP sockets ($($missing -join ', ')); restarting capture to include them"
            Stop-Segment
            Add-Filters $missing
            $ports = @($ports + $missing); $state.ports = @($ports)
            $state.socketChanges = @($state.socketChanges) + @(@{ at = [DateTime]::UtcNow.ToString('o'); addedPorts = @($missing) })
            Start-Segment
            Save-State 'capturing' "PktMon running on $($ports.Count) game sockets after a mid-game socket change"
            $missing = @()
            if ($SmokeTest) {
                $udp = New-Object Net.Sockets.UdpClient
                try {
                    $payload = [Text.Encoding]::ASCII.GetBytes('FF_RESEARCH_CAPTURE_SMOKE_TEST_2')
                    for ($i = 0; $i -lt 5; $i++) { $null = $udp.Send($payload, $payload.Length, $gateway, 54330); Start-Sleep -Milliseconds 200 }
                } finally { $udp.Dispose() }
                break
            }
        }
        Start-Sleep -Milliseconds 500
    }
} catch {
    $state.error = $_.Exception.Message
} finally {
    if ($segments.Count) {
        try {
            Save-State 'converting' 'Stopping capture and converting full packet data to PCAPNG'
            if ($started) { Stop-Segment }
            $state.stoppedAt = [DateTime]::UtcNow.ToString('o')
            if ($segments.Count -eq 1) {
                $state.conversionOutput = Invoke-Pkt @('etl2pcap', $segments[0], '--out', $pcap)
            } else {
                # PCAPNG sections concatenate cleanly; readers reset interfaces at each section header.
                $outputs = @(); $parts = @()
                for ($i = 0; $i -lt $segments.Count; $i++) {
                    $part = Join-Path $SessionDir ("segment-{0}.pcapng" -f ($i + 1))
                    $outputs += Invoke-Pkt @('etl2pcap', $segments[$i], '--out', $part)
                    $parts += $part
                }
                $state.conversionOutput = $outputs -join "`n---`n"
                $target = [IO.File]::Create($pcap)
                try { foreach ($part in $parts) { $bytes = [IO.File]::ReadAllBytes($part); $target.Write($bytes, 0, $bytes.Length) } } finally { $target.Dispose() }
                foreach ($part in $parts) { Remove-Item -LiteralPath $part -Force }
            }
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
    elseif ($segments.Count) { Save-State 'complete' 'PCAPNG saved; awaiting packet validation' }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
