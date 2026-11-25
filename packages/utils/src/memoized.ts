/**
 * The memo's answer for `key`, computed by `compute` on the first ask and handed to every later
 * caller of the key: the same promise, so a rejection is an answer too and is never retried.
 *
 * @param memo - The memo, owned by whoever owns its lifetime (a run, never the process)
 * @param key - The computation's identity
 * @param compute - The computation, called at most once per key
 * @returns The one promise for `key`
 */
export function memoized<T>(memo: Map<string, Promise<T>>, key: string, compute: () => Promise<T>): Promise<T> {
  const held = memo.get(key);
  if (held !== undefined) return held;
  const computed = compute();
  memo.set(key, computed);
  return computed;
}
