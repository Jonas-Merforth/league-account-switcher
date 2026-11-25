import { isSavedSessionVerified, sessionAgeWarning } from '../core/savedSessionVerification.js';

export function accountSessionView(account, now = Date.now()) {
  if (!account.hasSession) return { className: 'tag dim', text: account.hasPassword
    ? 'No saved session — will sign in with password'
    : 'No saved session — capture or add a password' };
  const saved = account.sessionAge?.text || 'Session saved';
  if (account.isCurrent) return { className: 'tag', text: 'Signed in to Riot Client', title: saved };
  const verification = account.sessionVerification;
  if (isSavedSessionVerified(verification, now)) return {
    className: 'tag', text: 'Session verified by Friends',
    title: verification.renewed
      ? `Riot renewed the saved session on ${new Date(verification.verifiedAt).toLocaleString()}.`
      : `${saved}. The saved session was recently accepted by Riot for Friends.`
  };
  return sessionAgeWarning(account, now)
    ? { className: 'tag warn', text: `${saved} — may be expired, re-capture` }
    : { className: 'tag', text: saved };
}

export function gameNameOnly(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const tagIndex = text.lastIndexOf('#');
  return tagIndex > 0 ? text.slice(0, tagIndex).trim() : text;
}

export function accountSubtitle(account = {}) {
  const gameName = gameNameOnly(account.lastSummonerName);
  const username = String(account.username || '').trim();
  if (gameName && username && gameName.toLowerCase() !== username.toLowerCase()) {
    return `${gameName} | ${username}`;
  }
  return gameName || username;
}
