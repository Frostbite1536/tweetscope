const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_IDLE_DELAY_MS = 250;
const RETRY_DELAY_MS = 100;

function createAbortError() {
  return new DOMException('Embed task cancelled', 'AbortError');
}

class EmbedScheduler {
  constructor({
    maxInFlight = DEFAULT_MAX_IN_FLIGHT,
    idleDelayMs = DEFAULT_IDLE_DELAY_MS,
  } = {}) {
    this.maxInFlight = maxInFlight;
    this.idleDelayMs = idleDelayMs;
    this.queue = [];
    this.tasksByKey = new Map();
    this.inFlightCount = 0;
    this.lastActivityAt = Date.now();
    this.pumpTimer = null;
    this.listenersAttached = false;
    this.handleActivity = this.handleActivity.bind(this);
    this.attachActivityListeners();
  }

  attachActivityListeners() {
    if (this.listenersAttached) return;
    if (typeof window === 'undefined') return;
    this.listenersAttached = true;
    const opts = { passive: true, capture: true };
    window.addEventListener('scroll', this.handleActivity, opts);
    window.addEventListener('wheel', this.handleActivity, opts);
    window.addEventListener('touchmove', this.handleActivity, opts);
    window.addEventListener('keydown', this.handleActivity, opts);
  }

  handleActivity() {
    this.lastActivityAt = Date.now();
    if (this.queue.length > 0) {
      this.schedulePump(this.idleDelayMs);
    }
  }

  isIdle() {
    return Date.now() - this.lastActivityAt >= this.idleDelayMs;
  }

  schedule(key, run, canRun = null) {
    const existing = this.tasksByKey.get(key);
    if (existing) return existing.promise;

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const task = {
      key,
      run,
      canRun,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      state: 'queued',
      cancelled: false,
    };

    this.tasksByKey.set(key, task);
    this.queue.push(task);
    this.schedulePump(0);
    return promise;
  }

  cancel(key) {
    const task = this.tasksByKey.get(key);
    if (!task) return;

    task.cancelled = true;
    if (task.state === 'queued') {
      this.queue = this.queue.filter((item) => item.key !== key);
      this.tasksByKey.delete(key);
      task.reject(createAbortError());
    }
  }

  schedulePump(delayMs) {
    if (this.pumpTimer !== null) return;
    this.pumpTimer = window.setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, delayMs);
  }

  pump() {
    if (this.inFlightCount >= this.maxInFlight) return;
    if (this.queue.length === 0) return;

    if (!this.isIdle()) {
      this.schedulePump(this.idleDelayMs);
      return;
    }

    let deferredCount = this.queue.length;
    while (this.inFlightCount < this.maxInFlight && this.queue.length > 0 && deferredCount > 0) {
      const task = this.queue.shift();
      if (!task || task.cancelled) {
        if (task) {
          this.tasksByKey.delete(task.key);
          task.reject(createAbortError());
        }
        deferredCount--;
        continue;
      }

      if (typeof task.canRun === 'function' && !task.canRun()) {
        this.queue.push(task);
        deferredCount--;
        continue;
      }

      this.startTask(task);
      deferredCount = this.queue.length;
    }

    if (this.queue.length > 0 && this.inFlightCount < this.maxInFlight) {
      this.schedulePump(RETRY_DELAY_MS);
    }
  }

  startTask(task) {
    task.state = 'in_flight';
    this.inFlightCount += 1;

    Promise.resolve()
      .then(() => task.run())
      .then((value) => {
        if (!task.cancelled) {
          task.resolve(value);
        }
      })
      .catch((error) => {
        if (!task.cancelled) {
          task.reject(error);
        }
      })
      .finally(() => {
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        this.tasksByKey.delete(task.key);
        if (this.queue.length > 0) {
          this.schedulePump(0);
        }
      });
  }
}

export const embedScheduler = new EmbedScheduler();
