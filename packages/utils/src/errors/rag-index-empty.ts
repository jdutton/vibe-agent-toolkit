/**
 * The `VatError` code a RAG query over an index with no chunk table throws.
 *
 * Here rather than beside its thrower (`@vibe-agent-toolkit/rag-lancedb`)
 * because its reader is the CLI's refusal map, which loads for every command:
 * importing it from the optional RAG backend would load that backend with it.
 * One constant, imported on both sides, so the thrower and the map cannot drift.
 */
export const RAG_INDEX_EMPTY_CODE = 'RAG_INDEX_EMPTY';

/**
 * The `VatError` code for a RAG database whose table LanceDB cannot open — its
 * files are damaged or truncated. The store is the caller's input, unreadable;
 * kept here for the same reason as {@link RAG_INDEX_EMPTY_CODE}.
 */
export const RAG_DATABASE_UNREADABLE_CODE = 'RAG_DATABASE_UNREADABLE';

/**
 * The `VatError` code for a RAG database path that `removeRagDatabase` will not
 * remove: a directory holding anything a database does not, or a symbolic link
 * (removing the link would leave the index it names in place). Nothing is removed.
 */
export const RAG_DATABASE_NOT_REMOVABLE_CODE = 'RAG_DATABASE_NOT_REMOVABLE';

/**
 * The `VatError` code for a RAG database removal the OS stopped partway: part
 * of the database may already be gone. The run did not finish; nothing is wrong with VAT.
 */
export const RAG_DATABASE_REMOVAL_INCOMPLETE_CODE = 'RAG_DATABASE_REMOVAL_INCOMPLETE';
