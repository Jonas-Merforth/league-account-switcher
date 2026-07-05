export const LOGIN_RETRY_STAGES = Object.freeze([
  'waiting-login',
  'logging-in',
  'solve-captcha',
  'manual'
]);

export function canRestartSwitchStatus(status = {}) {
  return Boolean(
    status.busy
    && status.id
    && LOGIN_RETRY_STAGES.includes(String(status.stage || ''))
  );
}

export function retryLoginTypingView(status = {}) {
  if (!canRestartSwitchStatus(status)) return { visible: false };
  return {
    visible: true,
    label: 'Retry login typing',
    title: 'Close Riot/League and repeat this login attempt.'
  };
}
