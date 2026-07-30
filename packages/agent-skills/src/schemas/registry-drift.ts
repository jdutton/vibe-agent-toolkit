/**
 * Shared primitives for reporting what a liberally-parsed registry absorbed.
 *
 * Claude Code owns `installed_plugins.json` and `known_marketplaces.json`; VAT only
 * reads them. Per VAT's Postel's Law rule (CLAUDE.md: "Reading outside world →
 * liberal") both schemas `.passthrough()`, so an unrecognized field or kind is drift
 * in someone else's file rather than an error in the user's setup.
 *
 * Liberality alone would be blindness, so each registry pairs its schema with a
 * detector built from these helpers. Everything the detectors find is reported by
 * the validator under the one `REGISTRY_SHAPE_DRIFT` code, at `info`.
 */

/** One thing in a registry that VAT's model does not recognize. */
export interface RegistryShapeDrift {
  /** Dotted pointer to the unrecognized field, or to the field carrying an unrecognized value. */
  field: string;
  /** Human-readable description of what was not recognized. */
  message: string;
}

/**
 * Drift accumulator, keyed by message rather than by pointer.
 *
 * The point of a drift observation is "Claude Code writes something new", not
 * "it wrote it 28 times" — so a registry whose every entry gained one field
 * yields one observation, carrying the first pointer that exhibited it.
 */
export type RegistryDriftRecord = Map<string, RegistryShapeDrift>;

/**
 * Narrow a value to a plain object (arrays and `null` excluded).
 *
 * @param value - Candidate value from parsed registry JSON
 * @returns True when the value can be key-walked
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Record one drift observation, keeping the first pointer seen for its message.
 *
 * @param record - Accumulator to add to
 * @param field - Dotted pointer to the unrecognized field
 * @param message - Description of what was not recognized
 */
export function recordDrift(
  record: RegistryDriftRecord,
  field: string,
  message: string,
): void {
  if (!record.has(message)) {
    record.set(message, { field, message });
  }
}

/**
 * Record every key of `value` that is not in `knownKeys`.
 *
 * @param value - Object to walk
 * @param knownKeys - Keys VAT's model recognizes
 * @param pointer - Dotted pointer to `value`, or `''` when it is the registry root
 * @param describe - Builds the observation message for an unrecognized key
 * @param record - Accumulator to add to
 */
export function recordUnknownKeys(
  value: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  pointer: string,
  describe: (key: string) => string,
  record: RegistryDriftRecord,
): void {
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      recordDrift(record, pointer === '' ? key : `${pointer}.${key}`, describe(key));
    }
  }
}
