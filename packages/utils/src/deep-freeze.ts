/**
 * Freeze a value and everything reachable from it through own enumerable
 * properties, so a write anywhere inside it throws (in strict mode, which every
 * ES module is) rather than silently changing what other holders see.
 *
 * For values shared by reference between independent readers: a reader that
 * needs to write takes its own copy of what it writes.
 *
 * 🪤 A typed array or `DataView` (a YAML `!!binary` frontmatter value, say) is
 * left writable: the language refuses to freeze an array buffer view that has
 * elements, so its bytes are the one thing a holder can still change.
 *
 * @param value - The value to freeze, in place
 * @returns `value`, frozen
 */
export function deepFreeze<T>(value: T): T {
  freezeReachable(value);
  return value;
}

/** Freeze `value` and what it reaches; an already-frozen object is a stop, which ends a cycle. */
function freezeReachable(value: unknown): void {
  if (!(value instanceof Object) || Object.isFrozen(value) || ArrayBuffer.isView(value)) return;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    freezeReachable((value as Record<PropertyKey, unknown>)[key]);
  }
}
