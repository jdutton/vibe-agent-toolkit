/**
 * The environment variable naming VAT's persistable cache directory. Declared here, in the layer-0
 * package, so the cache root that reads it (`vatCacheRoot` in `@vibe-agent-toolkit/resources`) and
 * the test scratch that unsets it (`scratchTmpdirEnv` in `@vibe-agent-toolkit/utils/testing`)
 * spell it once.
 */
export const VAT_CACHE_DIR_ENV = 'VAT_CACHE_DIR';
