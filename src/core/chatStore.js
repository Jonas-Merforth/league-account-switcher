import fs from 'node:fs';
import path from 'node:path';

import { getChatStatePath, getConfigDir } from './config.js';
import { dpapiProtect, dpapiUnprotect } from './secrets.js';

export function emptyChatState() {
  return { version: 1, activeKey: '', conversations: [] };
}

export function normalizeChatState(input = {}) {
  const conversations = [];
  for (const item of Array.isArray(input.conversations) ? input.conversations : []) {
    const sourceAccountId = String(item?.sourceAccountId || '').trim();
    const destinationPuuid = String(item?.destinationPuuid || '').trim().toLowerCase();
    if (!sourceAccountId || !destinationPuuid) continue;
    conversations.push({
      key: `${sourceAccountId}:${destinationPuuid}`,
      sourceAccountId,
      sourceLabel: String(item.sourceLabel || ''),
      destinationPuuid,
      destinationJid: String(item.destinationJid || ''),
      destinationRiotId: String(item.destinationRiotId || destinationPuuid),
      friendOnline: Boolean(item.friendOnline),
      unreadCount: Math.max(0, Number(item.unreadCount) || 0),
      draft: String(item.draft || '').slice(0, 4_000),
      open: item.open !== false,
      updatedAt: String(item.updatedAt || ''),
      messages: (Array.isArray(item.messages) ? item.messages : []).slice(-200).map((message) => ({
        id: String(message?.id || ''),
        body: String(message?.body || ''),
        incoming: Boolean(message?.incoming),
        receivedAt: String(message?.receivedAt || ''),
        delayed: Boolean(message?.delayed),
        status: String(message?.status || '')
      }))
    });
  }
  const activeKey = String(input.activeKey || '');
  return {
    version: 1,
    activeKey: conversations.some((item) => item.key === activeKey) ? activeKey : '',
    conversations
  };
}

export async function loadChatState({ file = getChatStatePath(), unprotect = dpapiUnprotect, log = () => {} } = {}) {
  try {
    const cipher = fs.readFileSync(file, 'utf8').trim();
    if (!cipher) return emptyChatState();
    return normalizeChatState(JSON.parse(await unprotect(cipher)));
  } catch (error) {
    if (error.code !== 'ENOENT') log(`Chat: encrypted history could not be loaded (${error.message}).`, 'warn');
    return emptyChatState();
  }
}

export async function saveChatState(state, { file = getChatStatePath(), protect = dpapiProtect } = {}) {
  const normalized = normalizeChatState(state);
  const cipher = await protect(JSON.stringify(normalized));
  fs.mkdirSync(path.dirname(file) || getConfigDir(), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${cipher}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return normalized;
}
