export class AppearOfflineState {
  constructor() {
    this.on = false;
    this.pendingNext = false;
  }

  get desired() {
    return this.on && !this.pendingNext;
  }

  setEnabled(enabled, { clientRunning = false } = {}) {
    this.on = Boolean(enabled);
    this.pendingNext = this.on && !clientRunning;
    return this.snapshot();
  }

  startSwitch(start) {
    return start();
  }

  completeSuccessfulSwitch() {
    const before = this.snapshot();
    if (this.on) {
      if (this.pendingNext) this.pendingNext = false;
      else this.on = false;
    }
    return before.on !== this.on || before.pendingNext !== this.pendingNext;
  }

  snapshot() {
    return {
      on: this.on,
      pendingNext: this.pendingNext,
      desired: this.desired
    };
  }
}
