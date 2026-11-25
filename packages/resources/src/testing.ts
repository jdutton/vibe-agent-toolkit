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
  contractContentKey,
  uncoveredBlobWrite,
  type BlobWriterContractCase,
  type BlobWriterContractFactory,
  type BlobWriterContractSubject,
} from './testing/blob-writer-contract.js';
