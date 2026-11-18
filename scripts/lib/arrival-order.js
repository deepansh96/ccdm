"use strict";

// Runs event handlers one at a time, in the order their events arrived.
//
// A transport hands over each event without waiting for the handler of the one
// before it, and a handler may await several steps before it acts. Wrapped
// here, each handler starts only once the one before it has finished, or has
// called `next()` because what it decided is in place and only slow work
// remains.
//
// A handler that has done neither within `timeoutMs` no longer holds the line:
// the later events go ahead, one line is logged, and the slow handler carries
// on and takes effect whenever it finishes.
const DEFAULT_TIMEOUT_MS = 30000;

function arrivalOrder({ timeoutMs = DEFAULT_TIMEOUT_MS, log = (line) => console.error(line) } = {}) {
  let last = Promise.resolve();
  // `kind` names the event in the log line; `handler(event, next)` handles one.
  return (kind, handler) => (event) => {
    const previous = last;
    let release;
    last = new Promise((resolve) => { release = resolve; });
    return previous.then(() => {
      const startedAt = Date.now();
      let timer = setTimeout(() => {
        timer = null;
        log(`[order] a ${kind} event held later events for ${Date.now() - startedAt} ms; they go ahead without it`);
        release();
      }, timeoutMs);
      timer.unref?.();
      const next = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        release();
      };
      return Promise.resolve().then(() => handler(event, next)).finally(next);
    });
  };
}

module.exports = { arrivalOrder, DEFAULT_TIMEOUT_MS };
