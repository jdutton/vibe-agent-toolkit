/**
 * The `blob_conditions` codes the blob stage writes for a blob it did not derive facts for.
 *
 * A leaf, importing nothing: the reader of the blob tier (`blob-resource-facts.ts`) and the
 * refusal log (`blob-refusals.ts`) both read these codes, and the blob stage
 * (`blob-population.ts`) both writes them and imports that reader, so the codes living in the
 * stage would close an import cycle.
 */

/** A blob whose bytes could not be read at derivation time. */
export const BLOB_UNREADABLE = 'BLOB_UNREADABLE';

/** The bytes at the chosen path no longer key to the blob the base recorded. */
export const BLOB_CONTENT_CHANGED = 'BLOB_CONTENT_CHANGED';

/** The parser threw on this blob's bytes. */
export const BLOB_PARSE_FAILED = 'BLOB_PARSE_FAILED';

/**
 * The parse of this blob was stopped at one of its limits (`parse-limits.ts`).
 *
 * A per-run outcome, never stored (ADR I6): the next run re-attempts the blob.
 * The message names the path and the limit, like {@link BLOB_UNREADABLE}'s,
 * because the row describes this run, not the bytes.
 */
export const BLOB_PARSE_LIMIT_EXCEEDED = 'BLOB_PARSE_LIMIT_EXCEEDED';

/**
 * The parse worker holding this blob's job died without answering — it exited,
 * or an uncaught error killed it (`ParseWorkerDiedError`).
 *
 * A per-run outcome, never stored (ADR I6), and never {@link BLOB_PARSE_FAILED}:
 * nothing says the bytes caused it, so the next run re-attempts the blob. The
 * message names the path and the cause, because the row describes this run.
 */
export const BLOB_PARSE_WORKER_DIED = 'BLOB_PARSE_WORKER_DIED';

/** The bytes are not text, so no text parser was run over them. */
export const BLOB_NOT_TEXT = 'BLOB_NOT_TEXT';
