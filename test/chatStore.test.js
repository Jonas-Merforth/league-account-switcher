import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyChatState, loadChatState, normalizeChatState, saveChatState } from '../src/core/chatStore.js';

test('chat state normalization rejects incomplete conversations and caps persisted content', () => {
  const messages = Array.from({ length: 205 }, (_, index) => ({ id: index, body: `message ${index}` }));
  const state = normalizeChatState({
    activeKey: 'source:friend',
    conversations: [
      { sourceAccountId: 'source', destinationPuuid: ' FRIEND ', draft: 'x'.repeat(5000), messages },
      { sourceAccountId: '', destinationPuuid: 'missing-source' }
    ]
  });
  assert.equal(state.conversations.length, 1);
  assert.equal(state.activeKey, 'source:friend');
  assert.equal(state.conversations[0].draft.length, 4000);
  assert.equal(state.conversations[0].messages.length, 200);
});

test('chat state is written and read through the encryption boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'las-chat-'));
  const file = path.join(root, 'chat-state.enc');
  const protect = async (plain) => Buffer.from(`protected:${plain}`).toString('base64');
  const unprotect = async (cipher) => Buffer.from(cipher, 'base64').toString('utf8').replace(/^protected:/, '');
  const input = { activeKey: 'source:friend', conversations: [{ sourceAccountId: 'source', destinationPuuid: 'friend', messages: [{ id: 'm1', body: 'private' }] }] };
  await saveChatState(input, { file, protect });
  assert.equal(fs.readFileSync(file, 'utf8').includes('private'), false);
  await saveChatState({ ...input, activeKey: '' }, { file, protect });
  const loaded = await loadChatState({ file, unprotect });
  assert.equal(loaded.conversations[0].messages[0].body, 'private');
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing or unreadable encrypted history falls back safely', async () => {
  const warnings = [];
  const loaded = await loadChatState({ file: path.join(os.tmpdir(), `missing-${Date.now()}`), log: (message) => warnings.push(message) });
  assert.deepEqual(loaded, emptyChatState());
  assert.equal(warnings.length, 0);
});
