import path from 'node:path';
import { runPowerShell } from './powershell.js';
import { RIOT_LOGIN_MSAA_SCRIPT } from './riotLoginMsaa.js';

// Native accessibility actions target Riot's form without global input or clipboard access.

export async function submitRiotLoginThroughControls({ username, password, servicesPath, execute = runPowerShell }) {
  const riotRoot = path.resolve(path.dirname(servicesPath)) + path.sep;
  const output = await execute(RIOT_LOGIN_MSAA_SCRIPT, {
    input: JSON.stringify({ username: String(username), password: String(password), riotRoot }),
    timeoutMs: 25_000
  });
  return JSON.parse(String(output).trim());
}
