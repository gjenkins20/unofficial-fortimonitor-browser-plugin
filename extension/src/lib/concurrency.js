// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Bounded-concurrency async map. Returns per-item results in the shape of
// Promise.allSettled so callers can iterate without per-item try/catch.
// Honors an AbortSignal for cooperative cancellation.

/**
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {object} [options]
 * @param {number} [options.concurrency=3]
 * @param {AbortSignal} [options.signal]
 * @param {(index: number, result: {status:'fulfilled'|'rejected', value?:R, reason?:unknown}) => void} [options.onItem]
 * @returns {Promise<Array<{status:'fulfilled'|'rejected', value?:R, reason?:unknown}>>}
 */
export async function mapConcurrent(items, fn, { concurrency = 3, signal, onItem } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('mapConcurrent: concurrency must be a positive integer');
  }
  if (!Array.isArray(items)) {
    throw new TypeError('mapConcurrent: items must be an array');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('mapConcurrent: fn must be a function');
  }

  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
      onItem?.(i, results[i]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  if (workerCount === 0) return [];
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
