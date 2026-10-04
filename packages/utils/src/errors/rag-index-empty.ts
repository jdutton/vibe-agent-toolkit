/**
 * The `VatError` code a RAG query over an index with no chunk table throws.
 *
 * Here rather than beside its thrower (`@vibe-agent-toolkit/rag-lancedb`)
 * because its reader is the CLI's refusal map, which loads for every command:
 * importing it from the optional RAG backend would load that backend with it.
 * One constant, imported on both sides, so the thrower and the map cannot drift.
 */
export const RAG_INDEX_EMPTY_CODE = 'RAG_INDEX_EMPTY';
