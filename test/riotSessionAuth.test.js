import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePslAuthorizationFromRiotYaml,
  updatePslAuthorizationInRiotYaml
} from '../src/core/friendPresencePoc.js';

const pslYaml = `psl:
    authorization:
        riot-client:
            id_token: "old-id"
            is_dpop_bound: false
            last_token_creation_time: 1000
            refresh_token: "old-refresh"
            refresh_token_write_count: 4
            scopes:
            - "openid"
            - "lol"
riot-login:
    persist: null
`;

test('parses Riot Player Session Lifecycle refresh credentials', () => {
  assert.deepEqual(parsePslAuthorizationFromRiotYaml(pslYaml), {
    refreshToken: 'old-refresh',
    idToken: 'old-id',
    isDpopBound: false,
    scopes: ['openid', 'lol']
  });
  assert.equal(parsePslAuthorizationFromRiotYaml('riot-login:\n  persist: null\n'), null);
});

test('retains rotated Riot refresh credentials without disturbing the session shape', () => {
  const updated = updatePslAuthorizationInRiotYaml(pslYaml, {
    refreshToken: 'new-refresh',
    idToken: 'new-id',
    now: 1234567890
  });

  assert.match(updated, /refresh_token: "new-refresh"/);
  assert.match(updated, /id_token: "new-id"/);
  assert.match(updated, /last_token_creation_time: 1234567890/);
  assert.match(updated, /refresh_token_write_count: 5/);
  assert.match(updated, /riot-login:\n    persist: null/);
  assert.equal(parsePslAuthorizationFromRiotYaml(updated)?.refreshToken, 'new-refresh');
});
