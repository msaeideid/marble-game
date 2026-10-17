export interface LagSimulation {
  /** Extra one-way delay in each direction, ms. */
  lagMs: number;
  /** Random extra delay up to this many ms (order is preserved, like TCP). */
  jitterMs: number;
}

export interface ConnectionHandlers {
  onOpen?: () => void;
  onMessage: (msg: Record<string, unknown>) => void;
  onClose?: () => void;
}

/**
 * Releases callbacks in strict due-time order. Per-message setTimeout calls can swap two messages that are due within
 * the same millisecond (browsers round delays), which TCP would never do, so one timer drains an ordered queue.
 */
class DelayQueue {
  private items: { due: number; fn: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  push(due: number, fn: () => void): void {
    this.items.push({ due, fn }); // `due` is non-decreasing, so appending keeps the queue ordered
    this.arm();
  }

  private arm(): void {
    if (this.timer !== null || this.items.length === 0) return;
    this.timer = setTimeout(() => this.drain(), Math.max(0, this.items[0]!.due - performance.now()));
  }

  private drain(): void {
    this.timer = null;
    const now = performance.now();
    while (this.items.length > 0 && this.items[0]!.due <= now + 0.5) this.items.shift()!.fn();
    this.arm();
  }
}

/** A WebSocket that speaks JSON and can simulate network latency, for testing prediction without a bad network. */
export class Connection {
  private ws: WebSocket;
  private lastOut = 0;
  private lastIn = 0;
  private readonly outQueue = new DelayQueue();
  private readonly inQueue = new DelayQueue();
  private closed = false;

  constructor(
    url: string,
    private readonly lag: LagSimulation,
    private readonly handlers: ConnectionHandlers,
  ) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.handlers.onOpen?.();
    this.ws.onclose = () => {
      this.closed = true;
      this.handlers.onClose?.();
    };
    this.ws.onmessage = (e) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      this.deliver(() => this.handlers.onMessage(msg as Record<string, unknown>), true);
    };
  }

  private deliver(fn: () => void, incoming: boolean): void {
    if (this.lag.lagMs <= 0 && this.lag.jitterMs <= 0) {
      fn();
      return;
    }
    const now = performance.now();
    const due = Math.max(incoming ? this.lastIn : this.lastOut, now + this.lag.lagMs + Math.random() * this.lag.jitterMs);
    if (incoming) this.lastIn = due;
    else this.lastOut = due;
    (incoming ? this.inQueue : this.outQueue).push(due, fn);
  }

  send(msg: object): void {
    const text = JSON.stringify(msg);
    this.deliver(() => {
      if (!this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
    }, false);
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }
}
