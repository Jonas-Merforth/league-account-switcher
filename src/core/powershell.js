import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15000;

// Shared helper for the Windows-only PowerShell integrations (DPAPI, process control, window
// automation). Uses Windows PowerShell (powershell.exe) for the same reason clicker.js does:
// Add-Type / System.Security DPAPI are guaranteed available there. Secrets are passed on stdin,
// never as command-line arguments, so they never appear in the process list.
export function runPowerShell(
  script,
  { input = null, timeoutMs = DEFAULT_TIMEOUT_MS, capturePartialStdout = false } = {}
) {
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
    let timedOut = false;
    const withPartialStdout = (error) => {
      if (capturePartialStdout) {
        Object.defineProperty(error, 'partialStdout', {
          value: stdout,
          configurable: true,
          enumerable: false
        });
      }
      return error;
    };
    const failure = (message) => {
      return withPartialStdout(new Error(message));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Reject from the close/error handler, not here. Callers that start a replacement process
      // must not proceed while the timed-out PowerShell child can still be shutting down.
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (timedOut) return; // close follows error; do not expose replacement work before child exit
      reject(withPartialStdout(error));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(failure('PowerShell command timed out.'));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(failure((stderr || stdout || `PowerShell exited with code ${code}`).trim()));
      }
    });

    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}
