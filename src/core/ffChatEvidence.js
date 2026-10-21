// LCU chat is a separate surface from the in-game HUD. These are alignment
// candidates only until a controlled game confirms delivery and clock meaning.
export function surrenderSystemMessage(message) {
  if (!message || !['system', 'notification'].includes(String(message.type).toLowerCase())) return null;
  const body = String(message.body || '').replace(/<[^>]*>/g, '').trim();
  const patterns = [
    ['vote-failed', /(?:surrender vote|vote to surrender|surrender voting)[^\n]{0,80}\b(?:failed|rejected|unsuccessful|did not pass)\b/i],
    ['surrender-accepted', /(?:surrender vote|vote to surrender|surrender voting)[^\n]{0,80}\b(?:passed|succeeded|successful|accepted)\b/i],
    ['surrender-accepted', /\b(?:your|enemy|opposing) team (?:has )?(?:agreed to (?:a )?surrender|surrendered)\b/i],
    ['vote-start', /(?:started|initiated|called|begun) (?:a |the )?(?:surrender vote|vote to surrender)/i],
    ['vote-start', /(?:surrender vote|vote to surrender|surrender voting) (?:has )?(?:started|begun)/i]
  ];
  const found = patterns.find(([, pattern]) => pattern.test(body));
  if (!found) return null;
  const stamp = message.timestamp ?? message.createdAt ?? message.time;
  const numeric = typeof stamp === 'number' || /^\d{10,13}$/.test(String(stamp)) ? Number(stamp) : NaN;
  const parsed = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(stamp);
  return { stage: found[0], side: /\byour team\b/i.test(body) ? 'ally' : 'unknown',
    // Do not retain player names or arbitrary chat content, even in system text.
    messageClass: `System surrender message: ${found[0]}`, messageType: message.type,
    sourceTimestamp: Number.isFinite(parsed) ? new Date(parsed).toISOString() : null,
    timestampMeaning: 'Client-supplied timestamp; relationship to in-game vote time unverified',
    sourceMeaning: 'LCU system message, not yet verified as an in-game surrender notification' };
}
