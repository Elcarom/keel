/**
 * Injected clock port ensuring identical time semantics across Replay, Paper, Demo, and Live.
 */
export interface Clock {
  nowMs(): number;
  isoNow(): string;
}

export class SystemClock implements Clock {
  public nowMs(): number {
    return Date.now();
  }

  public isoNow(): string {
    return new Date(this.nowMs()).toISOString();
  }
}

export class ManualClock implements Clock {
  private currentMs: number;

  public constructor(initialMs: number) {
    if (!Number.isInteger(initialMs) || initialMs < 0) {
      throw new Error(`Invalid initial timestamp for ManualClock: ${initialMs}`);
    }
    this.currentMs = initialMs;
  }

  public nowMs(): number {
    return this.currentMs;
  }

  public isoNow(): string {
    return new Date(this.currentMs).toISOString();
  }

  public advanceMs(deltaMs: number): void {
    if (!Number.isInteger(deltaMs) || deltaMs < 0) {
      throw new Error(`ManualClock cannot advance by negative or non-integer delta: ${deltaMs}`);
    }
    this.currentMs += deltaMs;
  }

  public setMs(nextMs: number): void {
    if (!Number.isInteger(nextMs) || nextMs < this.currentMs) {
      throw new Error(`ManualClock cannot move backward from ${this.currentMs} to ${nextMs}`);
    }
    this.currentMs = nextMs;
  }
}
