/**
 * Freeze a value and everything reachable from it through own properties and
 * through the keys and values of a `Map` or `Set`, so a property write anywhere
 * inside it throws (in strict mode, which every ES module is) rather than
 * silently changing what other holders see.
 *
 * For values shared by reference between independent readers: a reader that
 * needs to write takes its own copy of what it writes.
 *
 * 🪤 Two kinds of state stay writable, because `Object.freeze` cannot reach them:
 *
 * - A `Map`, `Set` or `Date` container (a YAML `!!omap`, `!!set` or timestamp
 *   frontmatter value, say): freezing one blocks its properties, not its
 *   internal slots, so `.set`, `.add`, `.delete`, `.clear` and `.setTime` still
 *   change it. The objects inside a `Map` or `Set` ARE frozen.
 * - A typed array or `DataView` (a YAML `!!binary` value): the language refuses
 *   to freeze an array buffer view that has elements, so its bytes are left as
 *   they are.
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
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      freezeReachable(key);
      freezeReachable(entry);
    }
  } else if (value instanceof Set) {
    for (const entry of value) freezeReachable(entry);
  }
}
