import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15000;

// Shared helper for the Windows-only PowerShell integrations (DPAPI, process control, window
// automation). Uses Windows PowerShell (powershell.exe) for the same reason clicker.js does:
// Add-Type / System.Security DPAPI are guaranteed available there. Secrets are passed on stdin,
// never as command-line arguments, so they never appear in the process list.
export function runPowerShell(script, { input = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PowerShell command timed out.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error((stderr || stdout || `PowerShell exited with code ${code}`).trim()));
      }
    });

    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}
