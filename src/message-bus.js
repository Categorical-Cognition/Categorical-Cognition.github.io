export class MessageBus {
  constructor() {
    this.handlers = new Map();
    this.queue = [];
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
    while (this.queue.length > 0) {
      const message = this.queue.shift();
      const handlers = this.handlers.get(message.type);
      if (!handlers) {
        continue;
      }
      for (const handler of handlers) {
        handler(message.payload);
      }
    }
    this.isFlushing = false;
  }
}
