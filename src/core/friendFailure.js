const NETWORK_CODES = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EPIPE', 'ETIMEDOUT'
]);

const LOCAL_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ERR_OSSL_EVP_BAD_DECRYPT']);

function errorMessage(error) {
  return String(error?.message || error || 'Unknown Friends error.');
}

export function classifyFriendFailure(error) {
  const message = errorMessage(error);
  const sourceCode = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || error?.statusCode || 0);

  if (sourceCode === 'FRIENDS_SESSION_MISSING_SSID'
    || sourceCode === 'FRIENDS_SESSION_INTERACTIVE_AUTH'
    || sourceCode === 'FRIENDS_SESSION_AUTH_REJECTED'
    || sourceCode === 'FRIENDS_TOKEN_AUTH_REJECTED'
    || sourceCode === 'FRIENDS_XMPP_AUTH_FAILED') {
    return { code: sourceCode, category: 'session-auth', retryable: false, recommendedAction: 'reauthenticate' };
  }
  if (sourceCode === 'FRIENDS_RATE_LIMITED' || status === 429) {
    return { code: 'FRIENDS_RATE_LIMITED', category: 'transient', retryable: true, recommendedAction: 'retry' };
  }
  if (sourceCode === 'FRIENDS_SERVICE_UNAVAILABLE' || status >= 500) {
    return { code: 'FRIENDS_SERVICE_UNAVAILABLE', category: 'transient', retryable: true, recommendedAction: 'retry' };
  }
  if (sourceCode === 'FRIENDS_TIMEOUT' || NETWORK_CODES.has(sourceCode)
    || /timed? out|socket hang up|network|temporary failure/i.test(message)) {
    return { code: sourceCode === 'FRIENDS_TIMEOUT' ? sourceCode : 'FRIENDS_NETWORK_ERROR', category: 'transient', retryable: true, recommendedAction: 'retry' };
  }
  if (sourceCode === 'FRIENDS_LOCAL_SESSION_ERROR' || LOCAL_CODES.has(sourceCode)
    || /decrypt|snapshot|session bundle|could not read|permission denied/i.test(message)) {
    return { code: 'FRIENDS_LOCAL_SESSION_ERROR', category: 'local', retryable: false, recommendedAction: 'inspect' };
  }
  return { code: 'FRIENDS_UNKNOWN_ERROR', category: 'unknown', retryable: true, recommendedAction: 'retry' };
}

export function friendFailureDetails(account, error) {
  return {
    accountId: account.id,
    label: account.label,
    error: errorMessage(error),
    ...classifyFriendFailure(error)
  };
}

export function reauthenticationFailures(errors) {
  return (Array.isArray(errors) ? errors : []).filter((failure) => failure?.recommendedAction === 'reauthenticate');
}
