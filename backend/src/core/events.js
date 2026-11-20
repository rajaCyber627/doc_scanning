// In-process domain events, so features can react to each other without importing
// each other. Listeners run asynchronously and must not throw (errors are logged).
//   'batch.touch'  (batchId)   something in a batch changed → recompute its status
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);
const inFlight = new Set();

function emit(name, ...args) {
  for (const fn of bus.listeners(name)) {
    const p = Promise.resolve()
      .then(() => fn(...args))
      .catch((e) => console.error(`event ${name} listener failed:`, e && e.message))
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
}

const on = (name, fn) => bus.on(name, fn);

/** Resolves when every listener started so far has finished (tests). */
async function idle() {
  while (inFlight.size) await Promise.all([...inFlight]);
}

module.exports = { emit, on, idle };
