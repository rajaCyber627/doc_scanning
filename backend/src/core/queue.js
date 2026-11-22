// Minimal in-process job queue with a concurrency limit.
// Jobs are lost if the process stops; runner.recoverStuck() re-queues them on
// start-up. A durable implementation (e.g. AWS SQS) can replace this later with
// the same add()/onIdle() interface.
class InProcessQueue {
  constructor({ concurrency = 3 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.running = 0;
    this.pending = [];
    this.idleWaiters = [];
  }

  /** Queue an async job; resolves/rejects with the job's result. */
  add(job) {
    return new Promise((resolve, reject) => {
      this.pending.push({ job, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.running < this.concurrency && this.pending.length) {
      const { job, resolve, reject } = this.pending.shift();
      this.running++;
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          this.running--;
          this._drain();
          if (!this.running && !this.pending.length) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((w) => w());
          }
        });
    }
  }

  /** Resolves when nothing is running or waiting (used by tests). */
  onIdle() {
    if (!this.running && !this.pending.length) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  size() {
    return { running: this.running, pending: this.pending.length };
  }
}

module.exports = { InProcessQueue };
