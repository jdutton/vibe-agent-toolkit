/**
 * The `code` Node gives the error a worker thread dies with when it reaches its
 * heap limit (`resourceLimits`).
 *
 * VAT's parse pool catches that death and records the document as
 * `BLOB_PARSE_FAILED`, and the population line names the code
 * (`1 parse failed [ERR_WORKER_OUT_OF_MEMORY]`). `vat-lab memory` reads the same
 * code on a child's stderr to mark a row out of heap. One constant, imported by
 * the reader and by the tests that build the error, so they cannot drift.
 */
export const WORKER_OUT_OF_MEMORY_CODE = 'ERR_WORKER_OUT_OF_MEMORY';
