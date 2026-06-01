/**
 * Run a promise with a timeout. Used by scripted drivers.
 */

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError(`operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(handle);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
