import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DamageIpCapture } from './damageIpCapture.js';

test('the Windows helper re-arms with pre-sleep heartbeats, a capture limit and a locked log', {
  skip: process.platform !== 'win32'
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-handoff-'));
  const first = path.join(root, '2026-11-21T12-06-27.241Z-11111111');
  const second = path.join(root, '2026-11-21T12-24-23.121Z-22222222');
  try {
    const beforeSleep = new Date(Date.now() - 10 * 60 * 60 * 1000);
    for (const session of [first, second]) {
      fs.mkdirSync(session);
      const heartbeat = path.join(session, 'heartbeat');
      fs.writeFileSync(heartbeat, 'alive');
      fs.utimesSync(heartbeat, beforeSleep, beforeSleep);
    }
    fs.writeFileSync(path.join(first, 'next-session'), path.basename(second));
    fs.writeFileSync(path.join(root, 'game_r3dlog.txt'), 'Command Line: "127.0.0.1 7100 fixture 1234"\r\n');
    const helper = path.join(root, 'damageCapture.ps1');
    const script = fs.readFileSync(new URL('./damageCapture.ps1', import.meta.url), 'utf8');
    fs.writeFileSync(helper, script.replace('Global\\LeagueDamageIpCapture', `Local\\LeagueDamageHandoff-${randomUUID()}`)
      .replace('[DamageIpCapture]::Run(', '[FixtureDamageIpCapture]::Run('));
    const captureSource = fs.readFileSync(new URL('./DamageIpCapture.cs', import.meta.url), 'utf8');
    fs.writeFileSync(path.join(first, 'DamageIpCapture.cs'), captureSource + `
public static class FixtureDamageIpCapture {
    public static string Run(string dir, int pid, long start, IPAddress peer, int port, long deadline, DamageHeartbeat heartbeat) {
        if (heartbeat.HasExpired()) throw new InvalidOperationException("Heartbeat expired after sleep.");
        File.WriteAllText(Path.Combine(dir, "raw-ipv4.pcapng"), start.ToString());
        string first = Environment.GetEnvironmentVariable("DAMAGE_TEST_CONTROL");
        if (dir == first) return "Packet size limit reached. Capture is partial.";
        File.WriteAllText(Path.Combine(first, "stop-helper"), "stop");
        return null;
    }
}
`);
    const driver = path.join(root, 'fixture.ps1');
    fs.writeFileSync(driver, `
param($Helper, $Root, $First)
$fixture = @{ reads = 0; originalStart = [DateTime]::UtcNow }
function Get-Process {
    [CmdletBinding()] param($Name)
    $fixture.reads++
    if ($fixture.reads -eq 4) {
        $fixture.lock = [IO.File]::Open((Join-Path $Root 'game_r3dlog.txt'), 'Open', 'ReadWrite', 'None')
    }
    if ($fixture.reads -eq 5) { $fixture.lock.Dispose() }
    $fixture.gameStart = switch ($fixture.reads) {
        2 { $null }
        3 { $fixture.originalStart }
        default { $fixture.originalStart.AddSeconds([int]($fixture.reads -gt 3)) }
    }
    [pscustomobject]@{ Id = 42; Path = $null; StartTime = $fixture.gameStart; HasExited = $true }
}
function Get-ChildItem {
    [CmdletBinding()] param($LiteralPath, $Filter, [switch]$Directory, [switch]$File)
    [pscustomobject]@{ CreationTimeUtc = $fixture.gameStart; FullName = (Join-Path $Root 'game_r3dlog.txt'); Length = 64 }
}
& $Helper -SessionDir $First -LeaguePath $Root -Continuous
`);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', driver, helper, root, first], { env: { ...process.env, DAMAGE_TEST_CONTROL: first }, timeout: 10_000 });
    const read = (session) => JSON.parse(fs.readFileSync(path.join(session, 'status.json'), 'utf8'));
    const firstResult = read(first);
    assert.equal(firstResult.state, 'complete');
    assert.match(firstResult.captureLimit, /partial/);
    const secondResult = read(second);
    assert.equal(secondResult.state, 'complete');
    assert.equal(secondResult.captureLimit, undefined);
    assert.ok(Date.parse(secondResult.gameStartedAt) > Date.parse(firstResult.gameStartedAt));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a wall-clock jump does not time out startup and a handoff remembers the helper already started', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damage-startup-'));
  const second = path.join(root, 'next');
  const capture = new DamageIpCapture({ onUpdate() {} });
  const helper = { directory: root, continuous: true };
  const clock = t.mock.method(Date, 'now');
  try {
    capture.helper = helper;
    capture.begin(root, { state: 'starting' });
    const beforeSleep = Date.now();
    capture.poll();
    clock.mock.mockImplementation(() => beforeSleep + 10 * 60 * 60 * 1000);
    capture.poll();
    assert.equal(capture.state.state, 'starting');
    fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({ state: 'complete' }));
    capture.poll();

    fs.mkdirSync(second);
    capture.begin(second, { state: 'waiting' });
    capture.handleHelperExit(helper);
    assert.equal(capture.state.detail, 'The administrator recorder stopped unexpectedly.');
  } finally {
    clearInterval(capture.timer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
