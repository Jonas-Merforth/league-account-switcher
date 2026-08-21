import fs from 'node:fs';

export function isProcessIdRunning(pid, signalProcess = process.kill) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    signalProcess(numericPid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but Windows would not let us signal it.
    return error?.code === 'EPERM';
  }
}

// League can leave its lockfile behind after it exits or is killed. Treat it as live only while the
// process that wrote it still exists, otherwise callers can mistake stale LCU credentials for a
// running client.
export function isLeagueLockfileLive(lockfilePath, { signalProcess = process.kill } = {}) {
  try {
    const raw = fs.readFileSync(lockfilePath, 'utf8').trim();
    const [name, pid, port, password, protocol] = raw.split(':');
    if (!name || !pid || !port || !password || !protocol) return false;
    return isProcessIdRunning(pid, signalProcess);
  } catch {
    return false;
  }
}
