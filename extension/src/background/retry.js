// Retry policy for per-device save operations.
//
// Exponential backoff with jitter, capped. Callers inject a predicate so
// they can opt out of retrying classes of error (e.g. auth failures —
// retrying won't help until the user re-authenticates).

/**
 * Compute the delay (ms) to wait before attempt `attemptIndex + 1`.
 * attemptIndex is 0-based for the attempt that just failed.
 */
export function backoffDelayMs(attemptIndex, { base = 500, max = 10_000, jitter = 0.2, random = Math.random } = {}) {
  const exp = base * Math.pow(2, attemptIndex);
  const capped = Math.min(exp, max);
  const jitterBand = capped * jitter;
  const offset = jitterBand * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + offset));
}

/**
 * Call `fn` until it resolves, up to `maxAttempts` times. Waits
 * `backoff(attempt)` between attempts. `shouldRetry(err)` gates whether
 * a failure is retried — return false to fail fast on permanent errors.
 */
export async function withRetry(fn, {
  maxAttempts = 3,
  shouldRetry = () => true,
  backoff = backoffDelayMs,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  signal
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('withRetry: maxAttempts must be a positive integer');
  }
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !shouldRetry(err)) break;
      const delay = backoff(attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}
