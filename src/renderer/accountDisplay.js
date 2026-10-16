import { isSavedSessionVerified } from '../core/savedSessionVerification.js';

export function accountSessionView(account, now = Date.now()) {
  if (!account.hasSession) return { className: 'tag dim', text: account.hasPassword
    ? 'No saved session — will sign in with password'
    : 'No saved session — capture or add a password' };
  const age = account.sessionAge || {};
  if (isSavedSessionVerified(account.sessionVerification, now)) return {
    className: 'tag', text: 'Session verified by Friends',
    title: `${age.text || 'Session saved'}. The saved session was recently accepted by Riot for Friends.`
  };
  return { className: age.stale ? 'tag warn' : 'tag', text: age.stale
    ? `${age.text} — may be expired, re-capture` : age.text || 'Session saved' };
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
