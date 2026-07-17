import { formatRiotId, sameRiotIdentity } from './accountIdentity.js';

function validateLiveFriendCredentials(account, credentials) {
  const liveRiotId = formatRiotId(credentials?.identity?.gameName, credentials?.identity?.tagLine);
  if (!account?.lastSummonerName || !liveRiotId || !sameRiotIdentity(account.lastSummonerName, liveRiotId)) {
    throw new Error('the signed-in League identity changed while Friends was preparing its refresh');
  }
  return credentials;
}

export async function createLiveFriendAuthOverride(account, { getCredentials, log = () => {} } = {}) {
  const loadCredentials = async (force) =>
    validateLiveFriendCredentials(account, await getCredentials(force));
  const credentials = await loadCredentials(false);
  log(`using live League credentials for current Friends source=${account.label}`);
  return {
    auth: credentials.auth,
    refresh: async () => (await loadCredentials(true)).auth
  };
}
