// Shared store with the League Client Automation app: keep APP_NAME identical so getConfigDir()
// resolves to the same %AppData%\LeagueClientAutomation folder and both apps see the same accounts.
export const APP_NAME = 'LeagueClientAutomation';

export const DEFAULT_LEAGUE_PATH = 'C:\\Riot Games\\League of Legends';

// Account manager / Riot Client switching.
// RiotClientServices.exe is the launcher that owns the Riot Sign-On session and spawns League.
// Its real path is read from RiotClientInstalls.json (rc_live/rc_default); this is the fallback.
export const DEFAULT_RIOT_CLIENT_SERVICES = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';
export const RIOT_CLIENT_INSTALLS_PATH = 'C:\\ProgramData\\Riot Games\\RiotClientInstalls.json';
// Paths below are relative to %LOCALAPPDATA%; resolved in config.js.
export const RIOT_SESSION_FILE_SUBPATH = 'Riot Games\\Riot Client\\Data\\RiotGamesPrivateSettings.yaml';
export const RIOT_CLIENT_LOCKFILE_SUBPATH = 'Riot Games\\Riot Client\\Config\\lockfile';
// Launch League on the live patchline once the Riot Client is signed in.
export const RIOT_LAUNCH_ARGS = ['--launch-product=league_of_legends', '--launch-patchline=live'];
// Image names killed (in order) before a session swap, children before the RiotClientServices parent.
export const RIOT_PROCESS_IMAGES = [
  'LeagueClient.exe',
  'LeagueClientUx.exe',
  'LeagueClientUxRender.exe',
  'League of Legends.exe',
  'RiotClientUx.exe',
  'RiotClientUxRender.exe',
  'RiotClientCrashHandler.exe',
  'RiotClientServices.exe'
];
// Gameflow phases during which switching would close a live game; switching is blocked unless forced.
export const ACCOUNT_SWITCH_BLOCKING_PHASES = ['ReadyCheck', 'ChampSelect', 'GameStart', 'InProgress'];
