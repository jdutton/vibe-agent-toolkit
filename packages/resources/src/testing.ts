/**
 * `@vibe-agent-toolkit/resources/testing`: contracts and fixtures shared by the
 * suites of more than one package, on a subpath so nothing here reaches the
 * runtime barrel.
 *
 * ⛔ Framework-free, as `@vibe-agent-toolkit/utils/testing` is: a published
 * subpath that imported a test framework would make it a runtime requirement
 * of every adopter importing it.
 */

export {
  BLOB_WRITER_CONTRACT,
  contractBlobRows,
  uncoveredBlobWrite,
  type BlobWriterContractCase,
  type BlobWriterContractFactory,
  type BlobWriterContractSubject,
} from './testing/blob-writer-contract.js';

// The row-set tier's writer contract, run against the SQLite store and the store double alike.
export {
  ROW_SET_WRITER_CONTRACT,
  contractRowSet,
  contractRowSetId,
  uncoveredRowSetWrite,
  type RowSetWriterContractCase,
  type RowSetWriterContractFactory,
  type RowSetWriterContractSubject,
} from './testing/row-set-writer-contract.js';

// The one way a fixture writes a content key it did not compute from bytes.
export { testContentKey } from './testing/test-content-key.js';

// The query lane's view of a projection, for suites that build one from fixture rows.
export { queryProjectionOf } from './projection/query-projection.js';
