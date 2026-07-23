import { formatSseEvent } from './contract.js';

export function writeSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function createSseWriter(res) {
  let closed = false;
  return {
    send(event, data) {
      if (closed || res.writableEnded) return;
      res.write(formatSseEvent(event, data));
    },
    end() {
      if (closed || res.writableEnded) return;
      closed = true;
      res.end();
    },
  };
}
