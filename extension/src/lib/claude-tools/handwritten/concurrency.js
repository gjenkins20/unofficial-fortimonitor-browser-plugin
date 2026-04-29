// FMN-111 / FMN-112: bounded-concurrency helper for hand-port bulk and
// composite tools. Mirrors the python BulkOperationExecutor(max_concurrent=N)
// shape: dispatch all tasks, run at most N at a time, collect results
// in input order.

/**
 * Run an async mapper over `items` with at most `concurrency` in flight.
 * Returns an array aligned with `items`, where each entry is either
 *   { ok: true, value: <result> } on success
 *   { ok: false, error: <message string> } on rejection
 *
 * Errors are captured per item so a single failure does not poison the
 * batch - matches the python tool semantics for bulk ops.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<Array<{ok:true, value:R} | {ok:false, error:string}>>}
 */
export async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items)) throw new TypeError('mapWithConcurrency: items must be an array');
  const n = Math.max(1, Math.floor(concurrency));
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        const value = await mapper(items[i], i);
        results[i] = { ok: true, value };
      } catch (err) {
        results[i] = { ok: false, error: err?.message ?? String(err) };
      }
    }
  }

  const workers = Array.from({ length: Math.min(n, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
