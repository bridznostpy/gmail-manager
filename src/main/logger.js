'use strict';
/**
 * Central event log. Everything the engines do funnels through here so the
 * dashboard's "live logs" panel shows one coherent stream. Emits to any
 * registered sink (the renderer bridge registers one at startup).
 */
const MAX_BUFFER = 1000;

class Logger {
  constructor() {
    this.buffer = [];
    this.sinks = new Set();
  }

  onLog(fn) {
    this.sinks.add(fn);
    return () => this.sinks.delete(fn);
  }

  log(level, scope, message, extra) {
    const entry = {
      ts: Date.now(),
      level, // 'info' | 'warn' | 'error' | 'success' | 'debug'
      scope, // 'parser' | 'cdp' | 'sender' | 'gmail' | 'telegram' | 'ai' | 'system'
      message: String(message),
      extra: extra || null,
    };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    for (const sink of this.sinks) {
      try { sink(entry); } catch (_e) { /* never let a sink break logging */ }
    }
    // Mirror to stdout for dev.
    const line = `[${scope}] ${entry.message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    return entry;
  }

  info(scope, msg, extra) { return this.log('info', scope, msg, extra); }
  warn(scope, msg, extra) { return this.log('warn', scope, msg, extra); }
  error(scope, msg, extra) { return this.log('error', scope, msg, extra); }
  success(scope, msg, extra) { return this.log('success', scope, msg, extra); }
  debug(scope, msg, extra) { return this.log('debug', scope, msg, extra); }

  recent(n = 200) {
    return this.buffer.slice(-n);
  }
}

module.exports = new Logger();
