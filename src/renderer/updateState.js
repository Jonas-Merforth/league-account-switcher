// Pure view-model for the update banner — no DOM, no Electron — so it's unit-testable. Given the
// current update `status` from the main process, whether the user has `dismissed` the banner this
// session, and whether `autoUpdate` is on, decide what (if anything) the banner shows.
//
// status: { state: 'idle'|'checking'|'available'|'none'|'downloading'|'downloaded'|'error',
//           version?, percent?, message?, manual? }
// returns: { visible, text, action: null|'download'|'install', dismissible, transient }
export function nextUpdateView(status, dismissed = false, autoUpdate = false) {
  const s = status || {};
  const state = s.state || 'idle';
  const v = s.version ? ` v${s.version}` : '';
  const hidden = { visible: false, text: '', action: null, dismissible: false, transient: false };

  switch (state) {
    case 'available':
      // Auto mode: the main process is already downloading; show progress info, no buttons, can't dismiss.
      if (autoUpdate) {
        return { visible: true, text: `Update available${v} — downloading…`, action: null, dismissible: false, transient: false };
      }
      // Manual mode: offer the update until the user dismisses it (until next launch / next check).
      if (dismissed) return hidden;
      return { visible: true, text: `Update available${v}`, action: 'download', dismissible: true, transient: false };

    case 'downloading': {
      const pct = Number.isFinite(s.percent) ? Math.round(s.percent) : 0;
      return { visible: true, text: `Downloading update… ${pct}%`, action: null, dismissible: false, transient: false };
    }

    case 'downloaded':
      if (autoUpdate) {
        return { visible: true, text: `Update ready${v} — restarting…`, action: null, dismissible: false, transient: false };
      }
      return { visible: true, text: `Update ready${v} — restart to install`, action: 'install', dismissible: false, transient: false };

    // Feedback states only matter when the user pressed "Check for updates" (manual).
    case 'checking':
      return { visible: Boolean(s.manual), text: 'Checking for updates…', action: null, dismissible: false, transient: true };
    case 'none':
      return { visible: Boolean(s.manual), text: "You're on the latest version.", action: null, dismissible: false, transient: true };
    case 'error':
      return { visible: Boolean(s.manual), text: `Update check failed: ${s.message || 'unknown error'}`, action: null, dismissible: false, transient: true };

    default:
      return hidden;
  }
}
