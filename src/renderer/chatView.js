export function chatSourceOptions(friend = {}) {
  const seen = Array.isArray(friend.seenFrom) ? friend.seenFrom : [];
  const unique = new Map();
  for (const raw of seen) {
    if (!raw || typeof raw === 'string') continue;
    const accountId = String(raw.accountId || '').trim();
    if (!accountId || unique.has(accountId)) continue;
    unique.set(accountId, {
      accountId,
      label: String(raw.label || accountId),
      jid: String(raw.jid || '')
    });
  }
  return [...unique.values()];
}

export function chatRoute(conversation = {}) {
  const source = String(conversation.sourceLabel || 'Account');
  const destination = String(conversation.destinationRiotId || conversation.destinationPuuid || 'Friend');
  return `${source} → ${destination}`;
}

export function chatPreview(conversation = {}) {
  const message = Array.isArray(conversation.messages) ? conversation.messages.at(-1) : null;
  if (!message?.body) return 'No messages yet';
  return `${message.incoming ? '' : 'You: '}${String(message.body).replace(/\s+/g, ' ').trim()}`;
}

export function chatConnectionView(conversation = {}, now = Date.now()) {
  if (conversation.connectionState === 'error') {
    return { tone: 'error', text: conversation.connectionError || 'Riot chat disconnected.' };
  }
  if (conversation.connectionState === 'connecting') {
    return { tone: 'connecting', text: 'Connecting source account…' };
  }
  if (conversation.connectionState === 'online') {
    const expiresAt = Date.parse(conversation.leaseExpiresAt || '');
    const remainingSeconds = Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - now) / 1_000)) : 0;
    return {
      tone: 'online',
      text: remainingSeconds > 0 ? `Source online for ${formatLease(remainingSeconds)}` : 'Source online'
    };
  }
  return { tone: 'offline', text: 'Source offline — open or send to reconnect' };
}

function formatLease(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
