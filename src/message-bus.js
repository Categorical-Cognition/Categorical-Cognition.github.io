export class MessageBus {
  constructor() {
    this.handlers = new Map();
    this.queue = [];
    this.queueHead = 0;
    this.isFlushing = false;
  }

  on(type, handler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type).add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  emit(type, payload = {}) {
    this.queue.push({ type, payload });
    if (!this.isFlushing) {
      this.isFlushing = true;
      queueMicrotask(() => this.flush());
    }
  }

  flush() {
    try {
      while (this.queueHead < this.queue.length) {
        const message = this.queue[this.queueHead];
        this.queue[this.queueHead++] = null;
        for (const handler of this.handlers.get(message.type) ?? []) {
          handler(message.payload);
        }
      }
    } finally {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
      this.isFlushing = this.queue.length > 0;
    }
  }
}
